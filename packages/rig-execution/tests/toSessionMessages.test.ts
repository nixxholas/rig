import { describe, expect, it } from "vitest";

import { toSessionMessages } from "@/toSessionMessages.js";

describe("toSessionMessages", () => {
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
