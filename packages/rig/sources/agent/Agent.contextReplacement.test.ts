import { createTestRootContext } from "../testing/createTestRootContext.js";
import { describe, expect, it } from "vitest";

import { createInferenceStream, defineModel, defineProvider } from "@slopus/rig-execution";
import { Agent } from "./Agent.js";
import { createNodeAgentContext } from "./context/createNodeAgentContext.js";
import { NativeProcessManager } from "../processes/index.js";

const ctx = createTestRootContext();

describe("Agent model context replacement", () => {
    it("replaces only model context while idle and preserves visible messages", () => {
        const { agent } = createAgent();
        const visible = user("visible", "Visible history.");
        const retained = user("retained", "Retained context.");
        agent.recordMessage(visible);

        agent.replaceContextMessages([retained]);

        expect(agent.snapshot()).toMatchObject({
            contextMessages: [{ id: "retained" }],
            messages: [{ id: "visible" }],
        });
    });

    it("rejects replacement while a run owns the context", async () => {
        let release: () => void = () => undefined;
        const blocked = new Promise<void>((resolve) => {
            release = resolve;
        });
        const { agent, model } = createAgent(blocked);
        const running = agent.send(ctx, "Start.");
        await Promise.resolve();

        expect(() => agent.replaceContextMessages([user("replacement", "Replacement.")])).toThrow(
            "Cannot replace model context while the agent is running.",
        );

        release();
        await running;
        await agent.close();
        expect(model.id).toBe("test/context-replacement");
    });
});

function createAgent(blocked: Promise<void> = Promise.resolve()) {
    const model = defineModel({
        defaultThinkingLevel: "off",
        id: "test/context-replacement",
        name: "Context replacement",
        thinkingLevels: ["off"],
    });
    const provider = defineProvider({
        id: "test",
        models: [model],
        stream() {
            return createInferenceStream(async function* () {
                await blocked;
                const message = {
                    api: "test",
                    content: [{ text: "Done", type: "text" as const }],
                    model: model.id,
                    provider: "test",
                    role: "assistant" as const,
                    stopReason: "stop" as const,
                    timestamp: 1,
                    usage: {
                        cacheRead: 0,
                        cacheWrite: 0,
                        cost: {
                            cacheRead: 0,
                            cacheWrite: 0,
                            input: 0,
                            output: 0,
                            total: 0,
                        },
                        input: 0,
                        output: 0,
                        totalTokens: 0,
                    },
                };
                yield { type: "done" as const, reason: "stop" as const, message };
                return message;
            });
        },
    });
    return {
        agent: new Agent({
            context: createNodeAgentContext(createTestRootContext().named("agent"), {
                cwd: "/tmp/rig-agent-context-replacement",
                processManager: new NativeProcessManager(),
            }),
            modelId: model.id,
            printToConsole: false,
            provider,
            tools: [],
        }),
        model,
    };
}

function user(id: string, text: string) {
    return {
        blocks: [{ text, type: "text" as const }],
        id,
        role: "user" as const,
    };
}
