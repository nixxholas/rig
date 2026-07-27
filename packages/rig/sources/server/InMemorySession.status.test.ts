import { describe, expect, it } from "vitest";

import { Agent, createNodeAgentContext } from "../agent/index.js";
import { NativeProcessManager } from "../processes/index.js";
import { createEventIdFactory, type ModelCatalog, type SessionEvent } from "../protocol/index.js";
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
 * The durable status is assigned from many places and used to be persisted
 * without ever being announced. These drive real transitions rather than
 * asserting the reporting helper, because the question is whether every change
 * a client cares about actually reaches the stream.
 */
describe("InMemorySession durable status", () => {
    it("announces the run starting and the session settling again", async () => {
        const session = createSession();
        const observed: string[] = [];
        const unsubscribe = session.events.subscribe((event) => {
            if (event.type === "session_status_changed") observed.push(event.data.status);
        });

        const submitted = session.submit({ text: "Say hello." });
        await expect(session.waitForRun(submitted.runId)).resolves.toEqual({
            status: "completed",
        });
        unsubscribe();

        // A sidebar has to see the session go busy and reach a terminal state on
        // its own, without asking for the whole session again.
        expect(observed).toEqual(["queued", "running", "completed"]);
        expect(session.snapshot().status).toBe("completed");

        await session.beginShutdown();
    });

    it("reports archiving separately, because it is not a lifecycle status", async () => {
        const session = createSession();
        const archived: boolean[] = [];
        const statuses: string[] = [];
        const unsubscribe = session.events.subscribe((event) => {
            if (event.type === "session_archived") archived.push(event.data.archived);
            if (event.type === "session_status_changed") statuses.push(event.data.status);
        });

        session.setArchived(true);
        unsubscribe();

        // Archiving a session is its own durable flag with its own event. Only
        // a session archived along with its workspace takes the archived
        // lifecycle status.
        expect(archived).toEqual([true]);
        expect(statuses).toEqual([]);

        await session.beginShutdown();
    });

    it("does not repeat a status that has not changed", async () => {
        const session = createSession();
        const observed: string[] = [];
        const unsubscribe = session.events.subscribe((event) => {
            if (event.type === "session_status_changed") observed.push(event.data.status);
        });

        const first = session.submit({ text: "One." });
        await session.waitForRun(first.runId);
        const second = session.submit({ text: "Two." });
        await session.waitForRun(second.runId);
        unsubscribe();

        // Two runs, so the session goes busy and settles twice and no more. A
        // status repeated on every save would flood the stream.
        expect(observed).toEqual([
            "queued",
            "running",
            "completed",
            "queued",
            "running",
            "completed",
        ]);

        await session.beginShutdown();
    });

    it("keeps status transitions durable, so a session list can follow them", async () => {
        const session = createSession();
        const submitted = session.submit({ text: "Say hello." });
        await session.waitForRun(submitted.runId);

        // Unlike activity, which changes constantly and is only ever the current
        // moment, a lifecycle status changes a handful of times per run. The
        // global stream a session list follows carries only durable events, so
        // these have to be among them.
        const events = session.events.since(undefined) ?? [];
        expect(
            events
                .filter((event: SessionEvent) => event.type === "session_status_changed")
                .map((event: SessionEvent) => (event.data as { status: string }).status),
        ).toEqual(["queued", "running", "completed"]);

        await session.beginShutdown();
    });
});

function createSession(): InMemorySession {
    const model = defineModel({
        defaultThinkingLevel: "off",
        id: "test/durable-status",
        name: "Durable status",
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
            cwd: "/tmp/rig-durable-status",
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
