import Anthropic from "@anthropic-ai/sdk";
import type { BetaRawMessageStreamEvent } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { describe, expect, it } from "vitest";

import type { SessionEvent } from "@/core/SessionEvent.js";
import { collectAnthropicCompaction } from "@/protocol/anthropic/collectAnthropicCompaction.js";
import { createAnthropicRequest } from "@/protocol/anthropic/createAnthropicRequest.js";
import { mapAnthropicStream } from "@/protocol/anthropic/mapAnthropicStream.js";
import { toAnthropicMessages } from "@/protocol/anthropic/toAnthropicMessages.js";
import { textFromSessionEvents } from "./helpers/collectSessionEvents.js";

const apiKey = process.env.ANTHROPIC_TEST_API_KEY;
const LIVE = process.env.RIG_LIVE_TEST === "1" && apiKey !== undefined;
const describeLive = LIVE ? describe : describe.skip;

describeLive("Anthropic protocol through the native API", () => {
    it("streams a native Claude Messages response", async () => {
        const client = new Anthropic({
            apiKey: apiKey!,
            maxRetries: 0,
        });
        const stream = await client.beta.messages.create({
            betas: ["interleaved-thinking-2025-05-14"],
            model: "claude-sonnet-5",
            max_tokens: 512,
            messages: toAnthropicMessages([
                { role: "user", content: "Reply exactly: anthropic protocol live ok" },
            ]),
            stream: true,
        });
        const events: SessionEvent[] = [];

        for await (const event of mapAnthropicStream(
            stream as AsyncIterable<BetaRawMessageStreamEvent>,
        )) {
            events.push(event);
        }

        expect(events.at(-1)).toEqual({ type: "done", state: "normal" });
        expect(textFromSessionEvents(events).toLowerCase()).toContain(
            "anthropic protocol live ok",
        );
        expect(events.some((event) => event.type === "token_usage")).toBe(true);
    }, 120_000);

    it("compacts natively and continues from the opaque checkpoint", async () => {
        const client = new Anthropic({ apiKey: apiKey!, maxRetries: 0 });
        const marker = "NATIVE_ANTHROPIC_COMPACTION_MARKER";
        const context = {
            instructions: "Preserve exact uppercase markers.",
            messages: [
                {
                    role: "user" as const,
                    content: `${marker}\n${"filler ".repeat(55_000)}`,
                },
            ],
        };
        const compacted = await collectAnthropicCompaction(
            await client.beta.messages.create(
                createAnthropicRequest({
                    compaction: {
                        instructions: `Preserve ${marker} exactly.`,
                    },
                    context,
                    model: "claude-sonnet-5",
                    tools: [],
                }),
            ),
        );

        expect(compacted.block?.content).toContain(marker);
        expect(compacted.usage.totalTokens).toBeGreaterThan(0);
        const block = compacted.block;
        if (block?.content === null || block?.content === undefined) {
            throw new Error("Native Anthropic compaction returned no checkpoint.");
        }
        const continuation = await client.beta.messages.create(
            createAnthropicRequest({
                context: {
                    instructions: context.instructions,
                    messages: [
                        {
                            role: "compaction",
                            content: block.content,
                            vendor: {
                                type: "anthropic_compaction",
                                encryptedContent: block.encrypted_content,
                            },
                        },
                        {
                            role: "user",
                            content: "Reply with only the preserved uppercase marker.",
                        },
                    ],
                },
                effort: "off",
                model: "claude-sonnet-5",
                tools: [],
            }),
        );
        const events: SessionEvent[] = [];
        for await (const event of mapAnthropicStream(continuation)) events.push(event);

        expect(events.at(-1)).toEqual({ type: "done", state: "normal" });
        expect(textFromSessionEvents(events)).toContain(marker);
    }, 180_000);
});