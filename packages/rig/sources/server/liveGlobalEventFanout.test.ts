import { describe, expect, it } from "vitest";

import { InMemorySessionStore } from "./InMemorySessionStore.js";
import { PersistentSessionStore } from "./PersistentSessionStore.js";
import type { SessionStore } from "./SessionStore.js";
import type { GlobalEvent } from "../protocol/index.js";

/**
 * One subscription has to be enough, so the live stream must carry what the
 * durable log deliberately drops as well as what it keeps.
 */
function collect(store: SessionStore): () => readonly GlobalEvent[] {
    const seen: GlobalEvent[] = [];
    store.liveEvents.subscribe((entry) => seen.push(entry.event));
    return () => seen;
}

function typesFor(events: readonly GlobalEvent[], sessionId: string): string[] {
    return events
        .filter((event) => "sessionId" in event && event.sessionId === sessionId)
        .map((event) => event.type);
}

describe("the live stream fans every event out", () => {
    it("carries durable, live-only, and project events from the memory store", () => {
        const store = new InMemorySessionStore();
        const events = collect(store);
        const session = store.create({ cwd: "/tmp/rig-live-fanout" });

        // A draft is live-only and never reaches the durable log.
        session.setDraft({ draft: "typed", updatedAt: Date.now() });
        // Archiving is durable.
        session.setArchived(true);

        const types = typesFor(events(), session.id);
        expect(types).toContain("session_draft_changed");
        expect(types).toContain("session_archived");
        expect(events().some((event) => "projectId" in event)).toBe(true);
    });

    it("carries the same events from the persistent store", () => {
        const store = new PersistentSessionStore({ databasePath: ":memory:" });
        try {
            const events = collect(store);
            const session = store.create({ cwd: "/tmp/rig-live-fanout-persistent" });
            session.setDraft({ draft: "typed", updatedAt: Date.now() });
            session.setArchived(true);

            const types = typesFor(events(), session.id);
            expect(types).toContain("session_draft_changed");
            expect(types).toContain("session_archived");
        } finally {
            store.close();
        }
    });

    it("numbers everything on one increasing cursor and never repeats an event", () => {
        const store = new PersistentSessionStore({ databasePath: ":memory:" });
        try {
            const cursors: string[] = [];
            const ids: string[] = [];
            store.liveEvents.subscribe((entry) => {
                cursors.push(entry.cursor);
                ids.push(`${entry.event.type}:${(entry.event as { id: string }).id}`);
            });
            const first = store.create({ cwd: "/tmp/rig-live-order" });
            const second = store.create({ cwd: "/tmp/rig-live-order-two" });
            first.setDraft({ draft: "a", updatedAt: Date.now() });
            second.setArchived(true);

            expect(cursors.length).toBeGreaterThan(0);
            expect([...cursors].sort()).toEqual(cursors);
            expect(new Set(cursors).size).toBe(cursors.length);
            // A live-only event delivered twice would show up as a duplicate here.
            expect(new Set(ids).size).toBe(ids.length);
        } finally {
            store.close();
        }
    });

    it("keeps the durable log free of the transient events the live stream adds", () => {
        const store = new PersistentSessionStore({
            databasePath: ":memory:",
            durableGlobalEventQueue: true,
        });
        try {
            const session = store.create({ cwd: "/tmp/rig-live-vs-durable" });
            session.setDraft({ draft: "typed", updatedAt: Date.now() });

            const durable = store.globalEventQueue.list() ?? [];
            expect(durable.some((entry) => entry.event.type === "session_draft_changed")).toBe(
                false,
            );
        } finally {
            store.close();
        }
    });
});
