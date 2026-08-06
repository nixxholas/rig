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

    /**
     * A provider-run search lives nowhere else. Rig never executed it, so no assistant message
     * records it and the window is the only carrier. Dropping it here deletes the searches off a
     * conversation somebody is already reading, the moment a stream reconnects — which is the one
     * thing this merge exists to prevent.
     */
    it("keeps the searches from both windows", () => {
        const call = (callId: string, createdAt: number, runId: string) => ({
            arguments: `{"query":"${callId}"}`,
            callId,
            createdAt,
            messageId: `message-${runId}`,
            name: "x_keyword_search",
            runId,
            status: "completed" as const,
        });
        const loaded: SessionTranscriptWindow = {
            complete: true,
            messages: [],
            providerToolCalls: [call("xs_old", 10, "run-1")],
            turns: [{ messageIds: [], runId: "run-1", startedAt: 1 }],
        };
        const incoming: SessionTranscriptWindow = {
            complete: false,
            messages: [],
            providerToolCalls: [call("xs_new", 20, "run-2")],
            turns: [{ messageIds: [], runId: "run-2", startedAt: 2 }],
        };

        expect(
            mergeTranscriptWindow(loaded, incoming).providerToolCalls?.map((each) => each.callId),
        ).toEqual(["xs_old", "xs_new"]);
    });

    // The fresh window is authoritative wherever the two overlap, exactly as it is for a turn.
    it("lets the fresh window settle a search it already held", () => {
        const shared = {
            callId: "xs_call-1",
            createdAt: 10,
            messageId: "message-1",
            name: "x_keyword_search",
            runId: "run-1",
        };
        const loaded: SessionTranscriptWindow = {
            complete: true,
            messages: [],
            providerToolCalls: [{ ...shared, arguments: "", status: "interrupted" as const }],
            turns: [{ messageIds: [], runId: "run-1", startedAt: 1 }],
        };
        const incoming: SessionTranscriptWindow = {
            complete: false,
            messages: [],
            providerToolCalls: [
                { ...shared, arguments: '{"query":"done"}', status: "completed" as const },
            ],
            turns: [{ messageIds: [], runId: "run-1", startedAt: 1 }],
        };

        expect(mergeTranscriptWindow(loaded, incoming).providerToolCalls).toEqual([
            { ...shared, arguments: '{"query":"done"}', status: "completed" },
        ]);
    });
});
