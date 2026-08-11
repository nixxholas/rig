import { describe, expect, it } from "vitest";

import type { SessionMessage } from "@/core/SessionContext.js";
import { getCodexTurnKey } from "@/vendors/codex/impl/getCodexTurnKey.js";

describe("getCodexTurnKey", () => {
    it("keeps one turn across continuations after a triggering native agent message", () => {
        const task: SessionMessage = {
            role: "agent",
            author: "/root",
            recipient: "/root/child",
            header: "Message Type: NEW_TASK\nPayload:\n",
            encryptedContent: "opaque-task",
            agentMessageTriggerTurn: true,
        };

        expect(getCodexTurnKey([task])).toBe(
            getCodexTurnKey([
                task,
                { role: "assistant", content: [{ type: "text", text: "Working." }] },
                {
                    role: "tool",
                    callId: "call-1",
                    content: [{ type: "text", text: "done" }],
                },
            ]),
        );
    });

    it("does not treat a queued native agent message as a new turn", () => {
        const human: SessionMessage = {
            role: "user",
            content: [{ type: "text", text: "Original task" }],
        };
        const queued: SessionMessage = {
            role: "agent",
            author: "/root",
            recipient: "/root/child",
            header: "Message Type: MESSAGE\nPayload:\n",
            encryptedContent: "opaque-message",
        };

        expect(getCodexTurnKey([human, queued])).toBe(getCodexTurnKey([human]));
    });

    it("treats every user message as a new turn boundary", () => {
        const first: SessionMessage = {
            role: "user",
            content: [{ type: "text", text: "Original task" }],
        };
        const next: SessionMessage = {
            role: "user",
            content: [{ type: "text", text: "Background context" }],
        };

        expect(getCodexTurnKey([first, next])).not.toBe(getCodexTurnKey([first]));
    });
});
