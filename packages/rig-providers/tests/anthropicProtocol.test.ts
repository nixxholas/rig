import type { BetaRawMessageStreamEvent } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { describe, expect, it } from "vitest";

import type { SessionEvent } from "@/core/SessionEvent.js";
import { mapAnthropicStream } from "@/protocol/anthropic/mapAnthropicStream.js";

describe("Anthropic protocol stop reasons", () => {
    it.each([
        ["pause_turn", { type: "done", state: "normal" }],
        [
            "refusal",
            {
                type: "done",
                state: "error",
                message: "The model refused to complete the request.",
            },
        ],
    ] as const)("maps %s explicitly", async (stopReason, expected) => {
        const events: SessionEvent[] = [];
        for await (const event of mapAnthropicStream(streamEndingWith(stopReason))) {
            events.push(event);
        }

        expect(events.at(-1)).toMatchObject(expected);
    });
});

async function* streamEndingWith(
    stopReason: "pause_turn" | "refusal",
): AsyncGenerator<BetaRawMessageStreamEvent> {
    yield {
        type: "message_start",
        message: {
            usage: { input_tokens: 1, output_tokens: 0 },
        },
    } as BetaRawMessageStreamEvent;
    yield {
        type: "message_delta",
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: { output_tokens: 1 },
    } as BetaRawMessageStreamEvent;
    yield { type: "message_stop" } as BetaRawMessageStreamEvent;
}