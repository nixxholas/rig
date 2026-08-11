import { describe, expect, it } from "vitest";

import { assistantMessageToAgentMessage } from "../assistantMessageToAgentMessage.js";
import { toProviderMessages } from "../../loop.js";
import { modelOpenaiGpt56Sol } from "@slopus/rig-execution";
import type { AssistantMessage } from "@slopus/rig-execution";

describe("assistantMessageToAgentMessage", () => {
    it("uses the Rig-owned message ID", () => {
        const message = assistantMessageToAgentMessage(providerMessage(), "rig-message-1", {
            providerId: "codex",
            requestedModelId: "openai/gpt-5.6",
        });

        expect(message.id).toBe("rig-message-1");
    });

    it("durably records requested and response model attribution", () => {
        const message = assistantMessageToAgentMessage(
            providerMessage({ responseModel: "gpt-5.6-2026-07-01" }),
            "rig-message-1",
            { providerId: "codex", requestedModelId: "openai/gpt-5.6" },
        );

        expect(message).toMatchObject({
            providerId: "codex",
            requestedModelId: "openai/gpt-5.6",
            responseModel: "gpt-5.6-2026-07-01",
        });
    });

    it("stores the model-invisible presentation on the durable block", () => {
        const source = providerMessage();
        const message = assistantMessageToAgentMessage(
            {
                ...source,
                content: [
                    {
                        type: "toolCall",
                        id: "call-1",
                        name: "read",
                        arguments: { path: "src/index.ts" },
                    },
                ],
            },
            "rig-message-1",
            { providerId: "pi", requestedModelId: "openai/gpt-5.6" },
            () => ({
                presentation: {
                    type: "exploration",
                    operations: [{ kind: "read", name: "index.ts" }],
                },
            }),
        );

        expect(message.blocks).toEqual([
            {
                type: "tool_call",
                id: "call-1",
                name: "read",
                arguments: { path: "src/index.ts" },
                presentation: {
                    type: "exploration",
                    operations: [{ kind: "read", name: "index.ts" }],
                },
            },
        ]);
    });

    it("preserves a function namespace through the durable agent transcript", () => {
        const source = providerMessage();
        const message = assistantMessageToAgentMessage(
            {
                ...source,
                content: [
                    {
                        type: "toolCall",
                        id: "call-spawn",
                        namespace: "collaboration",
                        name: "spawn_agent",
                        arguments: { task_name: "audit" },
                    },
                ],
            },
            "rig-message-1",
            { providerId: "codex", requestedModelId: modelOpenaiGpt56Sol.id },
        );

        expect(message.blocks).toEqual([
            {
                type: "tool_call",
                id: "call-spawn",
                namespace: "collaboration",
                name: "spawn_agent",
                arguments: { task_name: "audit" },
            },
        ]);
        expect(
            toProviderMessages([message], {
                model: modelOpenaiGpt56Sol,
                now: () => 2,
                providerId: "codex",
            }),
        ).toMatchObject([
            {
                content: [
                    {
                        type: "toolCall",
                        id: "call-spawn",
                        namespace: "collaboration",
                        name: "spawn_agent",
                    },
                ],
            },
        ]);
    });

    it("retains exact ordered provider blocks for the next session run", () => {
        const sessionMessage = {
            role: "assistant" as const,
            content: [
                { type: "reasoning" as const, text: "Think.", reasoning: "opaque" },
                { type: "text" as const, text: "Done." },
            ],
        };
        const message = assistantMessageToAgentMessage(
            { ...providerMessage(), sessionMessage },
            "rig-message-1",
            { providerId: "codex", requestedModelId: modelOpenaiGpt56Sol.id },
        );

        expect(message.sessionMessage).toBe(sessionMessage);
        expect(
            toProviderMessages([message], {
                model: modelOpenaiGpt56Sol,
                now: () => 2,
                providerId: "codex",
            }),
        ).toMatchObject([{ sessionMessage }]);
    });

    it("replays durable inference errors as model-readable untrusted context", () => {
        expect(
            toProviderMessages(
                [
                    {
                        attempt: 2,
                        blocks: [{ text: "The provider connection was lost.", type: "text" }],
                        id: "retry-2",
                        outcome: "retried",
                        role: "error",
                    },
                ],
                {
                    model: modelOpenaiGpt56Sol,
                    now: () => 2,
                    providerId: "codex",
                },
            ),
        ).toEqual([
            {
                content: [
                    { text: "Rig inference attempt 2 failed and was retried.", type: "text" },
                    { text: "The provider connection was lost.", type: "text" },
                ],
                role: "user",
                sourceMessageId: "retry-2",
                timestamp: 2,
            },
        ]);
    });
});

function providerMessage(options: { responseModel?: string } = {}): AssistantMessage {
    return {
        api: "responses",
        content: [{ text: "hello", type: "text" }],
        model: "openai/gpt-5.6",
        provider: "openai-codex",
        role: "assistant",
        stopReason: "stop",
        timestamp: 1,
        usage: {
            cacheRead: 3,
            cacheWrite: 4,
            cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
            input: 10,
            output: 2,
            totalTokens: 19,
        },
        ...(options.responseModel === undefined ? {} : { responseModel: options.responseModel }),
    };
}
