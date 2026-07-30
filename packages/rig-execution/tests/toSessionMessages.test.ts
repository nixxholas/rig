import { describe, expect, it } from "vitest";

import { toSessionMessages } from "@/toSessionMessages.js";

const zeroUsage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

describe("toSessionMessages", () => {
    it("replays provider tool call IDs instead of Rig IDs", () => {
        expect(
            toSessionMessages([
                {
                    role: "assistant",
                    content: [
                        {
                            type: "toolCall",
                            id: "rig-call-id",
                            providerToolCallId: "provider-call-id",
                            name: "example",
                            arguments: {},
                        },
                    ],
                    api: "test",
                    provider: "test",
                    model: "test",
                    contextTokens: 0,
                    usage: zeroUsage,
                    stopReason: "toolUse",
                    timestamp: 0,
                },
                {
                    role: "toolResult",
                    toolCallId: "rig-call-id",
                    providerToolCallId: "provider-call-id",
                    toolName: "example",
                    content: [{ type: "text", text: "done" }],
                    isError: false,
                    timestamp: 0,
                },
            ]),
        ).toMatchObject([
            { role: "assistant", toolCalls: [{ callId: "provider-call-id" }] },
            { role: "tool", callId: "provider-call-id" },
        ]);
    });

    it("retains signed and unsigned reasoning in caller-owned context", () => {
        const [message] = toSessionMessages([
            {
                role: "assistant",
                content: [
                    { type: "thinking", thinking: "Unsigned reasoning." },
                    {
                        type: "thinking",
                        thinking: "Signed reasoning.",
                        encrypted: "signature",
                    },
                    { type: "text", text: "Done." },
                ],
                api: "rig",
                provider: "test",
                model: "test-model",
                contextTokens: 0,
                usage: {
                    input: 0,
                    output: 0,
                    cacheRead: 0,
                    cacheWrite: 0,
                    totalTokens: 0,
                    cost: {
                        input: 0,
                        output: 0,
                        cacheRead: 0,
                        cacheWrite: 0,
                        total: 0,
                    },
                },
                stopReason: "stop",
                timestamp: 0,
            },
        ]);

        expect(message).toMatchObject({
            role: "assistant",
            content: "Done.",
            reasoning: [
                { text: "Unsigned reasoning." },
                { text: "Signed reasoning.", signature: "signature" },
            ],
        });
    });
});
