import { describe, expect, it } from "vitest";

import { resolvePreInferenceContextTokens } from "../resolvePreInferenceContextTokens.js";
import type { Message } from "../../types.js";

describe("resolvePreInferenceContextTokens", () => {
    it("adds messages after the latest provider-reported context checkpoint", () => {
        const messages: Message[] = [
            userMessage("old-user", "Ignored before the checkpoint."),
            {
                role: "agent",
                id: "checkpoint",
                blocks: [{ type: "text", text: "Already included." }],
                contextTokens: 8_000,
            },
            userMessage("new-user", "A".repeat(40)),
        ];

        expect(resolvePreInferenceContextTokens(messages)).toBe(8_018);
    });

    it("uses compacted context size when no later inference reported its size", () => {
        const messages: Message[] = [
            {
                role: "compaction",
                id: "compaction",
                blocks: [],
                replacedMessageIds: ["old-user", "old-agent"],
                statistics: {
                    before: { exact: true, tokens: 8_000 },
                    after: { exact: false, tokens: 1_500 },
                },
                providerId: "codex",
            },
            userMessage("new-user", "Continue."),
        ];

        expect(resolvePreInferenceContextTokens(messages)).toBe(1_511);
    });

    it("returns undefined without a durable context checkpoint", () => {
        expect(resolvePreInferenceContextTokens([userMessage("user", "Hello")])).toBeUndefined();
    });
});

function userMessage(id: string, text: string): Message {
    return {
        role: "user",
        id,
        blocks: [{ type: "text", text }],
    };
}
