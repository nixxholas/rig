import { createTestRootContext } from "../../testing/createTestRootContext.js";

const ctx = createTestRootContext();
import { describe, expect, it } from "vitest";

import { Agent, createNodeAgentContext } from "../../agent/index.js";
import { NativeProcessManager } from "../../processes/index.js";
import {
    createEventIdFactory,
    type ModelCatalog,
    type SessionEvent,
} from "../../protocol/index.js";
import type { CodingAssistantRuntime } from "../../runtime/CodingAssistantRuntime.js";
import type { CreateCodingAssistantAgentOptions } from "../../runtime/createCodingAssistantAgent.js";
import {
    createInferenceStream,
    defineModel,
    defineProvider,
    type AssistantMessage,
} from "@slopus/rig-execution";
import { InMemorySession } from "../InMemorySession.js";

describe("InMemorySession assistant message identity", () => {
    it("streams and commits one Rig-owned message ID", async () => {
        const model = defineModel({
            defaultThinkingLevel: "off",
            id: "test/message-identity",
            name: "Message identity",
            thinkingLevels: ["off"],
        });
        const provider = defineProvider({
            id: "test",
            models: [model],
            stream() {
                const message = assistantMessage(model.id);
                return createInferenceStream(async function* () {
                    yield { type: "start", partial: { ...message, content: [] } };
                    yield {
                        type: "text_delta",
                        contentIndex: 0,
                        delta: "Hello",
                        partial: message,
                    };
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
        const session = new InMemorySession(ctx, {
            createEventId: createEventIdFactory(),
            createRuntime: (options) => createRuntime(options, provider),
            modelCatalog: catalog,
            request: {
                cwd: "/tmp/rig-message-identity",
                modelId: model.id,
                providerId: provider.id,
            },
        });
        const observed: SessionEvent[] = [];
        const unsubscribe = session.events.subscribe((event) => {
            observed.push(event);
        });

        const submitted = await session.submit(ctx, { text: "Say hello." });
        await expect(session.waitForRun(ctx, submitted.runId)).resolves.toEqual({
            status: "completed",
        });
        unsubscribe();

        const assistantEvents = observed.flatMap((event) =>
            event.type === "agent_event" && "messageId" in event.data.event
                ? [event.data.event]
                : [],
        );
        const messageIds = new Set(assistantEvents.map((event) => event.messageId));
        expect(assistantEvents.map((event) => event.type)).toEqual([
            "inference_iteration_start",
            "start",
            "text_delta",
            "done",
        ]);
        expect(messageIds.size).toBe(1);
        const messageId = [...messageIds][0];
        expect(messageId).toBeDefined();

        const committed = observed.findLast((event) => event.type === "agent_message");
        expect(committed).toMatchObject({
            data: {
                message: { id: messageId },
                runId: submitted.runId,
            },
            type: "agent_message",
        });
        expect(session.snapshot().snapshot.messages.at(-1)?.id).toBe(messageId);

        await session.beginShutdown(ctx);
    });
});

function createRuntime(
    options: CreateCodingAssistantAgentOptions,
    provider: ReturnType<typeof defineProvider>,
): CodingAssistantRuntime {
    const processManager = new NativeProcessManager();
    const context = createNodeAgentContext(createTestRootContext().named("agent"), {
        cwd: options.cwd,
        processManager,
    });
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
