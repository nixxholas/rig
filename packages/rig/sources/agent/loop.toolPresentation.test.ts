import { describe, expect, it } from "vitest";

import { runAgentLoop } from "./loop.js";
import { claudeBashTool } from "./tools/claude/Bash.js";
import { createJustBashToolHarness } from "../tools/testing/createJustBashToolHarness.js";
import {
    createInferenceStream,
    defineModel,
    defineProvider,
    type AssistantMessage,
} from "@slopus/rig-execution";

describe("agent loop tool presentations", () => {
    it("publishes the Bash command presentation before execution starts", async () => {
        const model = defineModel({
            id: "mock/model",
            name: "Mock Model",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        let requestCount = 0;
        const provider = defineProvider({
            id: "mock",
            models: [model],
            stream() {
                requestCount += 1;
                const message =
                    requestCount === 1
                        ? assistantMessage(
                              [
                                  {
                                      type: "toolCall",
                                      id: "provider-call-bash",
                                      name: "Bash",
                                      arguments: { command: "printf ok" },
                                  },
                              ],
                              "toolUse",
                          )
                        : assistantMessage([{ type: "text", text: "done" }], "stop");
                return createInferenceStream(async function* () {
                    yield { partial: message, type: "start" };
                    yield { message, reason: message.stopReason, type: "done" };
                    return message;
                });
            },
        });
        const harness = createJustBashToolHarness();
        let publishedPresentation: unknown;
        let presentationAtExecution: unknown;
        const startSession = harness.context.bash.startSession.bind(harness.context.bash);
        harness.context.bash.startSession = (options) => {
            presentationAtExecution = publishedPresentation;
            return startSession(options);
        };

        await runAgentLoop({
            provider,
            modelId: model.id,
            tools: [claudeBashTool],
            messages: [
                {
                    role: "user",
                    id: "user-1",
                    blocks: [{ type: "text", text: "Run the command." }],
                },
            ],
            context: harness.context,
            onEvent(event) {
                if (event.type === "tool_execution_start") {
                    publishedPresentation = event.toolCall.presentation;
                }
            },
        });

        expect(presentationAtExecution).toEqual({
            command: "printf ok",
            type: "exec_command",
        });
    });
});

function assistantMessage(
    content: AssistantMessage["content"],
    stopReason: "length" | "stop" | "toolUse",
): Omit<AssistantMessage, "stopReason"> & {
    stopReason: "length" | "stop" | "toolUse";
} {
    return {
        api: "mock",
        content,
        model: "mock/model",
        provider: "mock",
        role: "assistant",
        stopReason,
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
