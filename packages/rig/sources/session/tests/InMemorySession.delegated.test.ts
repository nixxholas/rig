import { describe, expect, it, vi } from "vitest";

import { Agent, createNodeAgentContext } from "../../agent/index.js";
import { NativeProcessManager } from "../../processes/index.js";
import { createEventIdFactory, type ModelCatalog } from "../../protocol/index.js";
import type { CodingAssistantRuntime } from "../../runtime/CodingAssistantRuntime.js";
import type { CreateCodingAssistantAgentOptions } from "../../runtime/createCodingAssistantAgent.js";
import {
    createInferenceStream,
    defineModel,
    defineProvider,
    type AssistantMessage,
} from "@slopus/rig-execution";
import type { AgentSessionManager } from "../AgentSessionManager.js";
import { InMemorySession } from "../InMemorySession.js";

/**
 * A delegated session is the user's conversation, not the delegating agent's. The delegator keeps
 * working while the user is in there, so it has to be told the moment they say something.
 */
describe("InMemorySession delegated conversations", () => {
    it("reports a user message to the session that delegated the work", async () => {
        const notifyDelegatorOfUserMessage = vi.fn();
        const session = createDelegatedSession(notifyDelegatorOfUserMessage);

        const submitted = session.submit({ text: "Rewrite the summary instead." });
        await session.waitForRun(submitted.runId);

        expect(notifyDelegatorOfUserMessage).toHaveBeenCalledWith(
            session.id,
            "Rewrite the summary instead.",
        );

        await session.beginShutdown();
    });

    it("stays quiet when its own delegator is the one writing", async () => {
        const notifyDelegatorOfUserMessage = vi.fn();
        const session = createDelegatedSession(notifyDelegatorOfUserMessage);

        const submitted = session.submit({
            provenance: "agent",
            text: "Start with the changelog.",
        });
        await session.waitForRun(submitted.runId);

        expect(notifyDelegatorOfUserMessage).not.toHaveBeenCalled();

        await session.beginShutdown();
    });

    it("keeps the delegator on its metadata across a reload", () => {
        const session = createDelegatedSession(vi.fn());

        expect(session.agentMetadata().delegatedBySessionId).toBe("delegator-session");
        expect(session.snapshot().agent.delegatedBySessionId).toBe("delegator-session");
    });
});

function createDelegatedSession(
    notifyDelegatorOfUserMessage: (sessionId: string, text: string) => void,
): InMemorySession {
    const model = defineModel({
        defaultThinkingLevel: "off",
        id: "test/delegated",
        name: "Delegated",
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
    const sessionId = "delegated-session";
    return new InMemorySession({
        agentManager: { notifyDelegatorOfUserMessage } as unknown as AgentSessionManager,
        createEventId: createEventIdFactory(),
        createRuntime: (options) => createRuntime(options, provider),
        id: sessionId,
        metadata: {
            delegatedBySessionId: "delegator-session",
            depth: 0,
            rootSessionId: sessionId,
            type: "primary",
        },
        modelCatalog: catalog,
        request: {
            cwd: "/tmp/rig-delegated-session",
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
        content: [{ text: "Done", type: "text" }],
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
