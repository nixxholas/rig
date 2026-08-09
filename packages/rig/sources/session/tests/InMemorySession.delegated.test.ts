import { describe, expect, it } from "vitest";

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
import { InMemorySession } from "../InMemorySession.js";

/** A delegated session exposes its parent relationship for completion and agent-tree ownership. */
describe("InMemorySession delegated conversations", () => {
    it("exposes the delegator in its metadata and snapshot", async () => {
        const session = createDelegatedSession();

        expect(session.agentMetadata().delegatedBySessionId).toBe("delegator-session");
        expect(session.snapshot().agent.delegatedBySessionId).toBe("delegator-session");
    });
});

function createDelegatedSession(): InMemorySession {
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
