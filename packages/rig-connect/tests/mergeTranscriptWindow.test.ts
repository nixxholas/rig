import { describe, expect, it } from "vitest";

import { mergeTranscriptWindow } from "@/mergeTranscriptWindow.js";
import type { SessionTranscriptWindow } from "@/protocol.js";

describe("mergeTranscriptWindow", () => {
    it("preserves exact message-to-group identities across pages", () => {
        const loaded: SessionTranscriptWindow = {
            complete: true,
            messageBoundaryGroupId: { "boundary-1": "group-1" },
            messages: [
                {
                    blocks: [{ text: "Continue.", type: "text" }],
                    id: "boundary-1",
                    role: "user",
                },
            ],
            turns: [
                {
                    messageIds: ["boundary-1"],
                    runId: "run-1",
                    startedAt: 1,
                },
            ],
        };
        const incoming: SessionTranscriptWindow = {
            complete: false,
            messageGroupId: { "error-1": "group-2" },
            messages: [
                {
                    attempt: 2,
                    blocks: [{ text: "Connection lost.", type: "text" }],
                    id: "error-1",
                    outcome: "retried",
                    role: "error",
                },
            ],
            turns: [
                {
                    messageIds: ["error-1"],
                    runId: "run-2",
                    startedAt: 2,
                },
            ],
        };

        expect(mergeTranscriptWindow(loaded, incoming)).toMatchObject({
            messageBoundaryGroupId: { "boundary-1": "group-1" },
            messageGroupId: { "error-1": "group-2" },
        });
    });
});
