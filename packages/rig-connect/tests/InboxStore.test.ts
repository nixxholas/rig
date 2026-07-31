import { describe, expect, it } from "vitest";

import { InboxStore } from "../sources/InboxStore.js";
import type { GlobalEvent } from "../sources/protocol.js";

describe("InboxStore", () => {
    it("keeps questions shared across sessions and moves answers into date order", () => {
        const store = new InboxStore();
        store.apply(requested("session-1", "same-id", 10));
        store.apply(requested("session-2", "same-id", 20));

        expect(store.items().map((item) => item.id)).toEqual([
            "session-1:same-id",
            "session-2:same-id",
        ]);

        store.apply(resolved("session-1", "same-id", 30, "SQLite"));

        expect(store.items().map((item) => [item.id, item.status])).toEqual([
            ["session-2:same-id", "pending"],
            ["session-1:same-id", "answered"],
        ]);
        expect(store.items()[1]?.answers).toEqual({ database: ["SQLite"] });
    });

    it("removes a cancelled request instead of presenting it as completed", () => {
        const store = new InboxStore();
        store.apply(requested("session-1", "question-1", 10));

        store.apply({
            createdAt: 20,
            data: { requestId: "question-1", status: "cancelled" },
            id: "event-2",
            sessionId: "session-1",
            type: "user_input_resolved",
        });

        expect(store.items()).toEqual([]);
    });
});

function requested(sessionId: string, requestId: string, createdAt: number): GlobalEvent {
    return {
        createdAt,
        data: {
            questions: [
                {
                    header: "Database",
                    id: "database",
                    multiSelect: false,
                    options: [{ description: "Local and durable.", label: "SQLite" }],
                    question: "Which database should be used?",
                },
            ],
            requestId,
        },
        id: `event-${String(createdAt)}`,
        sessionId,
        type: "user_input_requested",
    };
}

function resolved(
    sessionId: string,
    requestId: string,
    createdAt: number,
    answer: string,
): GlobalEvent {
    return {
        createdAt,
        data: {
            answers: { database: [answer] },
            requestId,
            status: "answered",
        },
        id: `event-${String(createdAt)}`,
        sessionId,
        type: "user_input_resolved",
    };
}
