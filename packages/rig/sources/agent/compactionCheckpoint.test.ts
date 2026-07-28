import { describe, expect, it } from "vitest";

import { defineModel } from "@slopus/rig-execution";
import { toProviderMessages } from "./loop.js";
import type { Message } from "./types.js";

const model = defineModel({
    id: "openai/test",
    name: "Test",
    thinkingLevels: ["off"],
    defaultThinkingLevel: "off",
});

/**
 * Codex compacts into an encrypted checkpoint and returns no readable text. The checkpoint is not
 * a summary and must never reach the model as one; it goes back exactly as it arrived, and only to
 * the provider that issued it.
 */
describe("compaction checkpoints", () => {
    const summary: Message = {
        role: "user",
        id: "summary",
        blocks: [
            { type: "text", text: "<conversation_summary>\nNotice.\n</conversation_summary>" },
        ],
        compactionCheckpoint: { content: "opaque-checkpoint", providerId: "codex" },
    };

    it("replays the checkpoint verbatim to the provider that issued it", () => {
        expect(toProviderMessages([summary], { model, now: () => 1, providerId: "codex" })).toEqual(
            [{ role: "compaction", content: "opaque-checkpoint", timestamp: 1 }],
        );
    });

    it("never shows the opaque payload to the model as summary text", () => {
        const messages = toProviderMessages([summary], {
            model,
            now: () => 1,
            providerId: "codex",
        });

        expect(JSON.stringify(messages)).not.toContain("conversation_summary");
        expect(messages[0]).not.toMatchObject({ role: "user" });
    });

    it("falls back to the readable summary for a provider that cannot read it", () => {
        expect(
            toProviderMessages([summary], { model, now: () => 1, providerId: "claude" }),
        ).toEqual([
            {
                role: "user",
                content: [
                    {
                        type: "text",
                        text: "<conversation_summary>\nNotice.\n</conversation_summary>",
                    },
                ],
                timestamp: 1,
            },
        ]);
    });
});
