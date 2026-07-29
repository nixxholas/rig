import { describe, expect, it } from "vitest";

import { ResponsesSession } from "@/protocol/responses/ResponsesSession.js";

describe("SessionCompaction", () => {
    it("reports that a standard endpoint has no native compaction", async () => {
        const session = new ResponsesSession("session", {
            apiKey: "test-key",
            endpoint: "http://127.0.0.1:1/v1",
            nativeCompaction: false,
            context: {
                instructions: "System prompt.",
                messages: [{ role: "system", content: "Preserved metadata." }],
            },
        });

        const result = await session.compact();

        expect(result).toEqual({
            status: "failed",
            kind: "inference_error",
            message: "This Responses API endpoint does not provide native compaction.",
            context: {
                instructions: "System prompt.",
                messages: [{ role: "system", content: "Preserved metadata." }],
            },
        });
    });

    it("returns cancellation separately and leaves context untouched", async () => {
        const context = {
            instructions: "System prompt.",
            messages: [{ role: "user" as const, content: "Original state." }],
        };
        const session = new ResponsesSession("session", {
            apiKey: "test-key",
            endpoint: "http://127.0.0.1:1/v1",
            context,
        });
        const controller = new AbortController();
        controller.abort();

        await expect(session.compact({ signal: controller.signal })).resolves.toEqual({
            status: "cancelled",
            context,
        });
    });
});
