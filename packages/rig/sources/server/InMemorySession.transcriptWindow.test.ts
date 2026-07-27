import { describe, expect, it } from "vitest";

import { Agent, createNodeAgentContext } from "../agent/index.js";
import { NativeProcessManager } from "../processes/index.js";
import { createEventIdFactory, type ModelCatalog } from "../protocol/index.js";
import type { CodingAssistantRuntime } from "../runtime/CodingAssistantRuntime.js";
import type { CreateCodingAssistantAgentOptions } from "../runtime/createCodingAssistantAgent.js";
import {
    createInferenceStream,
    defineModel,
    defineProvider,
    type AssistantMessage,
} from "@slopus/rig-execution";
import { InMemorySession } from "./InMemorySession.js";

/**
 * These drive real runs rather than appending events by hand, because the point
 * is that the daemon knows the turn boundaries it reports. Events written
 * directly into the log would prove only that the window builder works.
 */
describe("InMemorySession transcript window", () => {
    it("reports each real run as one turn with its own outcome", async () => {
        const session = createSession();

        const first = session.submit({ text: "First ask." });
        await expect(session.waitForRun(first.runId)).resolves.toEqual({ status: "completed" });
        const second = session.submit({ text: "Second ask." });
        await expect(session.waitForRun(second.runId)).resolves.toEqual({ status: "completed" });

        const window = session.transcriptWindow();

        expect(window.turns.map((turn) => turn.runId)).toEqual([first.runId, second.runId]);
        expect(window.complete).toBe(true);
        for (const turn of window.turns) {
            expect(turn.outcome).toBe("success");
            expect(turn.startedAt).toBeGreaterThan(0);
            // A finished turn must carry an end, or a client cannot render the
            // elapsed footer it is promised for history.
            expect(turn.endedAt).toBeGreaterThanOrEqual(turn.startedAt);
        }

        await session.beginShutdown();
    });

    it("keeps a turn's messages together under that turn", async () => {
        const session = createSession();

        const submitted = session.submit({ text: "Say hello." });
        await expect(session.waitForRun(submitted.runId)).resolves.toEqual({
            status: "completed",
        });

        const window = session.transcriptWindow();
        const ids = window.turns.flatMap((turn) => turn.messageIds);

        // Every message in the window belongs to exactly one reported turn, so a
        // client never has to guess where a message came from.
        expect(ids).toEqual(window.messages.map((message) => message.id));
        expect(new Set(ids).size).toBe(ids.length);

        await session.beginShutdown();
    });

    it("drops whole turns rather than splitting one when the window is full", async () => {
        const session = createSession();

        const first = session.submit({ text: "First ask." });
        await session.waitForRun(first.runId);
        const second = session.submit({ text: "Second ask." });
        await session.waitForRun(second.runId);

        const window = session.transcriptWindow(1);

        expect(window.turns).toHaveLength(1);
        expect(window.turns[0]?.runId).toBe(second.runId);
        expect(window.complete).toBe(false);
        // The retained turn keeps every message it had; the bound is in turns.
        expect(window.messages.map((message) => message.id)).toEqual(
            window.turns[0]?.messageIds ?? [],
        );

        await session.beginShutdown();
    });

    it("does not grow the window as the conversation gets longer", async () => {
        const session = createSession();

        for (let index = 0; index < 6; index += 1) {
            const submitted = session.submit({ text: `Ask ${index}.` });
            await session.waitForRun(submitted.runId);
        }

        // The cost of attaching has to follow recent activity, not the age of
        // the session, which is the whole reason the window exists.
        const window = session.transcriptWindow(2);
        expect(window.turns).toHaveLength(2);
        expect(JSON.stringify(window).length).toBeLessThan(
            JSON.stringify(session.transcriptWindow(6)).length,
        );

        await session.beginShutdown();
    });
});

function createSession(): InMemorySession {
    const model = defineModel({
        defaultThinkingLevel: "off",
        id: "test/transcript-window",
        name: "Transcript window",
        thinkingLevels: ["off"],
    });
    const provider = defineProvider({
        id: "test",
        models: [model],
        stream() {
            const message = assistantMessage(model.id);
            return createInferenceStream(async function* () {
                yield { type: "start", partial: { ...message, content: [] } };
                yield { type: "done", reason: "stop", message };
                return message;
            });
        },
    });
    const catalog: ModelCatalog = {
        defaultModelId: model.id,
        defaultProviderId: provider.id,
        models: [model],
        providers: [{ providerId: provider.id, models: [model] }],
    };
    return new InMemorySession({
        createEventId: createEventIdFactory(),
        createRuntime: (options) => createRuntime(options, provider),
        modelCatalog: catalog,
        request: {
            cwd: "/tmp/rig-transcript-window",
            modelId: model.id,
            providerId: provider.id,
        },
    });
}

function createRuntime(
    options: CreateCodingAssistantAgentOptions,
    provider: ReturnType<typeof defineProvider>,
): CodingAssistantRuntime {
    const processManager = new NativeProcessManager();
    const context = createNodeAgentContext({ cwd: options.cwd, processManager });
    return {
        agent: new Agent({
            context,
            modelId: options.modelId ?? provider.models[0]?.id ?? "",
            printToConsole: false,
            provider,
            tools: [],
        }),
        context,
        cwd: options.cwd,
        executor: provider,
        processManager,
    };
}

function assistantMessage(model: string): AssistantMessage {
    return {
        api: "test",
        content: [{ text: "Hello", type: "text" }],
        model,
        provider: "test",
        role: "assistant",
        stopReason: "stop",
        timestamp: 1,
        usage: {
            cacheRead: 0,
            cacheWrite: 0,
            cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
            input: 0,
            output: 0,
            totalTokens: 0,
        },
    };
}
