import { describe, expect, it } from "vitest";

import type { SessionTranscriptWindow } from "../../protocol/index.js";
import { projectClientTranscript } from "../projectClientTranscript.js";

describe("projectClientTranscript", () => {
    it("keeps visible rows while removing provider and model-only payloads", () => {
        const huge = "x".repeat(512 * 1_024);
        const transcript: SessionTranscriptWindow = {
            complete: false,
            messages: [
                {
                    blocks: [],
                    id: "compaction",
                    providerId: "codex",
                    replacedMessageIds: Array.from(
                        { length: 1_000 },
                        (_, index) => `message-${index}`,
                    ),
                    replacementMessages: [{ role: "user", content: huge, timestamp: 1 }],
                    role: "compaction",
                    statistics: {
                        after: { exact: true, tokens: 1 },
                        before: { exact: true, tokens: 2 },
                    },
                },
                {
                    blocks: [
                        { encrypted: huge, thinking: "Visible reasoning", type: "thinking" },
                        {
                            arguments: { path: "README.md" },
                            id: "call-1",
                            name: "read_file",
                            type: "tool_call",
                            vendor: huge,
                        },
                        {
                            display: "Read README.md",
                            rendered: [{ text: huge, type: "text" }],
                            toolCallId: "call-1",
                            toolName: "read_file",
                            trustedUserEvidence: [{ text: huge, type: "text" }],
                            type: "tool_result",
                            vendor: huge,
                        },
                    ],
                    id: "agent",
                    sessionMessage: {
                        role: "assistant",
                        content: [{ type: "reasoning", reasoning: huge }],
                    },
                    role: "agent",
                },
            ],
            turns: [
                {
                    endedAt: 2,
                    messageIds: ["compaction", "agent"],
                    outcome: "success",
                    runId: "run-1",
                    startedAt: 1,
                },
            ],
        };

        const projected = projectClientTranscript(transcript);

        expect(JSON.stringify(projected).length).toBeLessThan(2_000);
        expect(projected.messages[1]?.blocks).toMatchObject([
            { thinking: "Visible reasoning", type: "thinking" },
            { arguments: { path: "README.md" }, name: "read_file", type: "tool_call" },
            { display: "Read README.md", rendered: [], type: "tool_result" },
        ]);
        expect(projected.messages[0]).toMatchObject({ replacedMessageIds: [] });
        expect(JSON.stringify(projected)).not.toContain(huge);
    });

    it("does not split a turn and leave lifecycle rows without their visible messages", () => {
        const messages = Array.from({ length: 100 }, (_, index) => ({
            blocks: [{ text: `Message ${index}`, type: "text" as const }],
            id: `message-${index}`,
            role: "agent" as const,
        }));
        const transcript: SessionTranscriptWindow = {
            complete: true,
            messageCreatedAt: Object.fromEntries(
                messages.map((message, index) => [message.id, index]),
            ),
            messages,
            turns: [
                {
                    endedAt: 2,
                    messageIds: messages.map((message) => message.id),
                    outcome: "success",
                    runId: "run-1",
                    startedAt: 1,
                },
            ],
        };

        const projected = projectClientTranscript(transcript);

        expect(projected.messages).toHaveLength(100);
        expect(projected.messages.map((message) => message.id)).toEqual(
            messages.map((message) => message.id),
        );
        expect(projected.turns[0]?.messageIds).toEqual(
            projected.messages.map((message) => message.id),
        );
        expect(Object.keys(projected.messageCreatedAt ?? {})).toEqual(
            projected.messages.map((message) => message.id),
        );
        expect(projected.complete).toBe(true);
    });

    it("does not inline multi-megabyte visible blocks into a client bootstrap", () => {
        const huge = "x".repeat(7 * 1_024 * 1_024);
        const transcript: SessionTranscriptWindow = {
            complete: true,
            messages: [
                {
                    blocks: [
                        { data: huge, mediaType: "image/png", type: "image" },
                        { text: huge, type: "text" },
                    ],
                    id: "user",
                    role: "user",
                },
                {
                    blocks: [
                        {
                            arguments: { payload: huge },
                            id: "call",
                            name: "large_tool",
                            type: "tool_call",
                        },
                    ],
                    id: "agent",
                    role: "agent",
                },
            ],
            turns: [
                {
                    endedAt: 2,
                    messageIds: ["user", "agent"],
                    outcome: "success",
                    runId: "run",
                    startedAt: 1,
                },
            ],
        };

        const projected = projectClientTranscript(transcript);
        const serialized = JSON.stringify(projected);

        expect(Buffer.byteLength(serialized)).toBeLessThan(100 * 1_024);
        expect(serialized).not.toContain(huge);
        expect(serialized).toContain("omitted");
    });
});
