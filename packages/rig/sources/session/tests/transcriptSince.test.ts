import { describe, expect, it } from "vitest";

import { InMemorySessionStore } from "../InMemorySessionStore.js";

/**
 * Catching a conversation up from the last message a client holds.
 *
 * A gap can begin in the middle of a turn, so the unit here is a whole turn: the
 * turn holding the anchor comes back complete and the client replaces it, rather
 * than stitching the back half of one turn onto the front half it already had.
 */

function messageEventIds(store: InMemorySessionStore, sessionId: string): string[] {
    const session = store.get(sessionId)!;
    return (session.events.since(undefined) ?? [])
        .filter((event) => event.type === "message_submitted")
        .map((event) => event.id);
}

describe("paging a transcript forward", () => {
    it("resends the anchor's own turn, because the client may hold half of it", () => {
        const store = new InMemorySessionStore();
        const session = store.create({ cwd: "/tmp/rig-forward-current" });
        session.submit({ text: "One." });
        const newest = messageEventIds(store, session.id).at(-1)!;

        // Even a client holding the newest message gets that turn back. The
        // anchor says which message it has, not whether its turn had finished,
        // so the turn is replaced wholesale rather than assumed complete.
        const page = session.transcriptSince(newest)!;
        expect(JSON.stringify(page.messages)).toContain("One.");
        expect(page.complete).toBe(true);
    });

    it("returns the turn holding the anchor complete, not just what follows it", () => {
        const store = new InMemorySessionStore();
        const session = store.create({ cwd: "/tmp/rig-forward-midturn" });
        session.submit({ text: "First." });
        session.submit({ text: "Second." });
        const [first] = messageEventIds(store, session.id);

        // The anchor is the first message, so its own turn must come back whole.
        const page = session.transcriptSince(first!);
        expect(page).toBeDefined();
        const texts = JSON.stringify(page!.messages);
        expect(texts).toContain("First.");
        expect(texts).toContain("Second.");
    });

    it("includes messages the client never saw", () => {
        const store = new InMemorySessionStore();
        const session = store.create({ cwd: "/tmp/rig-forward-missed" });
        session.submit({ text: "Held." });
        const anchor = messageEventIds(store, session.id).at(-1)!;
        session.submit({ text: "Missed one." });
        session.submit({ text: "Missed two." });

        const page = session.transcriptSince(anchor)!;
        const texts = JSON.stringify(page.messages);
        expect(texts).toContain("Missed one.");
        expect(texts).toContain("Missed two.");
        expect(page.complete).toBe(true);
    });

    it("serves an ancient anchor while nothing has been trimmed away", () => {
        const store = new InMemorySessionStore();
        const session = store.create({ cwd: "/tmp/rig-forward-ancient" });
        session.submit({ text: "Only." });

        // Older than any event this session issued, but the session still holds
        // its whole history, so paging forward from it can skip nothing.
        const page = session.transcriptSince("00000000-0000-7000-8000-000000000000")!;
        expect(JSON.stringify(page.messages)).toContain("Only.");
        expect(page.complete).toBe(true);
    });
});
