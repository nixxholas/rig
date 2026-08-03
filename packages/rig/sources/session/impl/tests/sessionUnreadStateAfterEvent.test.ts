import { describe, expect, it } from "vitest";

import type { SessionEvent } from "../../../protocol/index.js";
import { sessionUnreadStateAfterEvent } from "../sessionUnreadStateAfterEvent.js";

describe("sessionUnreadStateAfterEvent", () => {
    it("marks questions as attention needed and completed turns as finished", () => {
        expect(sessionUnreadStateAfterEvent(undefined, event("user_input_requested"))).toEqual({
            reason: "attention_needed",
            since: 10,
        });
        expect(sessionUnreadStateAfterEvent(undefined, event("run_finished"))).toEqual({
            reason: "turn_finished",
            since: 10,
        });
    });

    it("does not let a later turn boundary obscure unread attention", () => {
        const attention = { reason: "attention_needed", since: 5 } as const;

        expect(sessionUnreadStateAfterEvent(attention, event("run_error"))).toEqual(attention);
        expect(sessionUnreadStateAfterEvent(attention, event("session_updated"))).toEqual(
            attention,
        );
    });

    it("marks passive friend context unread without outranking an open question", () => {
        expect(sessionUnreadStateAfterEvent(undefined, friendMessageEvent())).toEqual({
            reason: "friend_message",
            since: 10,
        });
        const friend = { reason: "friend_message", since: 5 } as const;
        expect(sessionUnreadStateAfterEvent(friend, event("run_finished"))).toEqual(friend);
        const attention = { reason: "attention_needed", since: 4 } as const;
        expect(sessionUnreadStateAfterEvent(attention, friendMessageEvent())).toEqual(attention);
    });
});

function event(type: SessionEvent["type"]): SessionEvent {
    return {
        createdAt: 10,
        data: {},
        id: "event-1",
        sessionId: "session-1",
        type,
    } as SessionEvent;
}

function friendMessageEvent(): SessionEvent {
    return {
        createdAt: 10,
        data: {
            delivery: "context",
            displayText: "Hello",
            message: {
                blocks: [{ text: "Hello", type: "text" }],
                contextOnly: true,
                friendAuthor: {
                    displayName: "Grace",
                    grantEpoch: 1,
                    kind: "friend",
                    murmurPeerId: "peer-1",
                    shareId: "share-1",
                    shareMemberId: "member-1",
                },
                id: "friend-1",
                role: "user",
            },
            runId: "friend:friend-1",
        },
        id: "event-friend",
        sessionId: "session-1",
        type: "message_submitted",
    };
}
