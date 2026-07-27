import { describe, expect, it } from "vitest";
import type { Message } from "../agent/types.js";
import {
    sessionTranscriptWindow,
    type TranscriptEntry,
    type TranscriptRunFacts,
} from "./sessionTranscriptWindow.js";

function userMessage(id: string): Message {
    return { blocks: [{ text: id, type: "text" }], id, role: "user" };
}

function agentMessage(id: string): Message {
    return { blocks: [{ text: id, type: "text" }], id, role: "agent" };
}

/** A turn of one prompt and one reply, plus `toolCalls` extra agent messages. */
function turn(runId: string, toolCalls = 0): TranscriptEntry[] {
    const entries: TranscriptEntry[] = [{ message: userMessage(`${runId}-u`), runId }];
    for (let index = 0; index < toolCalls; index += 1) {
        entries.push({ message: agentMessage(`${runId}-t${index}`), runId });
    }
    entries.push({ message: agentMessage(`${runId}-a`), runId });
    return entries;
}

describe("sessionTranscriptWindow", () => {
    it("groups contiguous messages of one run into a single turn", () => {
        const window = sessionTranscriptWindow(turn("run-1", 2), new Map(), 20);

        expect(window.turns).toHaveLength(1);
        expect(window.turns[0]?.messageIds).toEqual(["run-1-u", "run-1-t0", "run-1-t1", "run-1-a"]);
        expect(window.complete).toBe(true);
    });

    it("keeps only the most recent turns when the conversation is longer", () => {
        const entries = Array.from({ length: 50 }, (_, index) => turn(`run-${index}`)).flat();

        const window = sessionTranscriptWindow(entries, new Map(), 20);

        expect(window.turns).toHaveLength(20);
        expect(window.turns[0]?.runId).toBe("run-30");
        expect(window.turns.at(-1)?.runId).toBe("run-49");
        expect(window.complete).toBe(false);
    });

    it("never splits a turn, so a long turn arrives whole", () => {
        // The oldest turn is dropped entirely; the newest is 40 messages and is
        // kept intact rather than trimmed to fit a message budget.
        const entries = [...turn("run-old"), ...turn("run-big", 38)];

        const window = sessionTranscriptWindow(entries, new Map(), 1);

        expect(window.turns).toHaveLength(1);
        expect(window.turns[0]?.messageIds).toHaveLength(40);
        expect(window.messages).toHaveLength(40);
        expect(window.messages.every((message: Message) => message.id.startsWith("run-big"))).toBe(
            true,
        );
    });

    it("reports the transcript complete when every turn fits", () => {
        const entries = [...turn("run-1"), ...turn("run-2")];

        expect(sessionTranscriptWindow(entries, new Map(), 20).complete).toBe(true);
    });

    it("carries the timing and outcome of each retained turn", () => {
        const facts = new Map<string, TranscriptRunFacts>([
            ["run-1", { endedAt: 90, outcome: "success", startedAt: 10 }],
            ["run-2", { endedAt: 260, errorMessage: "Boom", outcome: "error", startedAt: 200 }],
        ]);

        const window = sessionTranscriptWindow([...turn("run-1"), ...turn("run-2")], facts, 20);

        expect(window.turns[0]).toMatchObject({ endedAt: 90, outcome: "success", startedAt: 10 });
        expect(window.turns[1]).toMatchObject({ errorMessage: "Boom", outcome: "error" });
    });

    it("leaves a still-running turn without an end", () => {
        const facts = new Map<string, TranscriptRunFacts>([["run-1", { startedAt: 10 }]]);

        const window = sessionTranscriptWindow(turn("run-1"), facts, 20);

        expect(window.turns[0]?.endedAt).toBeUndefined();
        expect(window.turns[0]?.outcome).toBeUndefined();
    });

    it("omits messages the model needs but a reader must never see", () => {
        const entries: TranscriptEntry[] = [
            { message: { ...userMessage("hidden"), internal: true }, runId: "run-1" },
            ...turn("run-1"),
        ];

        const window = sessionTranscriptWindow(entries, new Map(), 20);

        expect(window.messages.map((message: Message) => message.id)).not.toContain("hidden");
    });

    it("keeps messages with no run of their own from joining a neighbouring turn", () => {
        const entries: TranscriptEntry[] = [
            { message: userMessage("loose-1") },
            { message: userMessage("loose-2") },
        ];

        const window = sessionTranscriptWindow(entries, new Map(), 20);

        expect(window.turns).toHaveLength(2);
    });
});
