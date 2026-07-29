import { describe, expect, it } from "vitest";

import { Agent, createNodeAgentContext } from "../agent/index.js";
import { HappyMessageMapper } from "../happy/mapSessionEventToHappyMessages.js";
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

const PROVIDER_FAILURE =
    "An error occurred while processing your request. Please include the request ID 2c64043a in your message.";

describe("InMemorySession provider failures", () => {
    it("keeps the provider error text on the durable run boundary", async () => {
        const session = createSession();

        const run = session.submit({ text: "Fail this turn." });
        await session.waitForRun(run.runId);

        const boundary = runBoundary(session, run.runId);
        expect(boundary.data).toMatchObject({ errorMessage: PROVIDER_FAILURE });
    });

    it("reports the failed turn to external consumers instead of a completed one", async () => {
        const session = createSession();

        const run = session.submit({ text: "Fail this turn." });
        await session.waitForRun(run.runId);

        const mapper = new HappyMessageMapper();
        const happy = (session.events.since(undefined) ?? [])
            .flatMap((event) => mapper.map(event))
            .map((message) => message.content.ev);
        // The failure reads as the same line a failed attempt gets, told apart
        // by the outcome, and the turn still ends.
        expect(happy).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    outcome: "failed",
                    reason: PROVIDER_FAILURE,
                    t: "failure",
                }),
                expect.objectContaining({ status: "failed", t: "turn-end" }),
            ]),
        );
    });
});

function createSession(): InMemorySession {
    const model = defineModel({
        defaultThinkingLevel: "off",
        id: "test/provider-failure",
        name: "Provider failure",
        thinkingLevels: ["off"],
    });
    const provider = defineProvider({
        id: "test",
        models: [model],
        stream() {
            const message = assistantError(model.id);
            return createInferenceStream(async function* () {
                yield { type: "start", partial: message };
                yield { type: "error", reason: "error", error: message };
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
            cwd: "/tmp/rig-provider-failure",
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
        processManager,
        executor: provider,
    };
}

function assistantError(model: string): AssistantMessage {
    return {
        api: "test",
        content: [],
        errorMessage: PROVIDER_FAILURE,
        model,
        provider: "test",
        role: "assistant",
        stopReason: "error",
        timestamp: Date.now(),
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

function runBoundary(session: InMemorySession, runId: string) {
    const boundary = session.events
        .since(undefined)
        ?.findLast(
            (event) =>
                (event.type === "run_finished" || event.type === "run_error") &&
                event.data.runId === runId,
        );
    if (boundary === undefined) throw new Error("The run produced no durable boundary event.");
    return boundary;
}
