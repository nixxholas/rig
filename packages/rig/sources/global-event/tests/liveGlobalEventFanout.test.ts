import { describe, expect, it } from "vitest";

import { InMemorySessionStore } from "../../session/InMemorySessionStore.js";
import { PersistentSessionStore } from "../../session/PersistentSessionStore.js";
import type { SessionStore } from "../../session/SessionStore.js";
import type { GlobalEvent } from "../../protocol/index.js";

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
    it("carries durable, live-only, and project events from the memory store", async () => {
        const store = await InMemorySessionStore.open();
        const events = collect(store);
        const session = await store.create({ cwd: "/tmp/rig-live-fanout" });

        // A draft is live-only and never reaches the durable log.
        await session.setDraft({ draft: "typed", updatedAt: Date.now() });
        // Archiving is durable.
        await session.setArchived(true);

        const types = typesFor(events(), session.id);
        expect(types).toContain("session_draft_changed");
        expect(types).toContain("session_archived");
        expect(events().some((event) => "projectId" in event)).toBe(true);
        await store.close();
    });

    it("carries the same events from the persistent store", async () => {
        const store = await PersistentSessionStore.open({ databasePath: ":memory:" });
        try {
            const events = collect(store);
            const session = await store.create({ cwd: "/tmp/rig-live-fanout-persistent" });
            await session.setDraft({ draft: "typed", updatedAt: Date.now() });
            await session.setArchived(true);

            const types = typesFor(events(), session.id);
            expect(types).toContain("session_draft_changed");
            expect(types).toContain("session_archived");
        } finally {
            await store.close();
        }
    });

    it("numbers everything on one increasing cursor and never repeats an event", async () => {
        const store = await PersistentSessionStore.open({ databasePath: ":memory:" });
        try {
            const cursors: string[] = [];
            const ids: string[] = [];
            store.liveEvents.subscribe((entry) => {
                cursors.push(entry.cursor);
                ids.push(`${entry.event.type}:${(entry.event as { id: string }).id}`);
            });
            const first = await store.create({ cwd: "/tmp/rig-live-order" });
            const second = await store.create({ cwd: "/tmp/rig-live-order-two" });
            await first.setDraft({ draft: "a", updatedAt: Date.now() });
            await second.setArchived(true);

            expect(cursors.length).toBeGreaterThan(0);
            expect([...cursors].sort()).toEqual(cursors);
            expect(new Set(cursors).size).toBe(cursors.length);
            // A live-only event delivered twice would show up as a duplicate here.
            expect(new Set(ids).size).toBe(ids.length);
        } finally {
            await store.close();
        }
    });

    it("keeps the durable log free of the transient events the live stream adds", async () => {
        const store = await PersistentSessionStore.open({
            databasePath: ":memory:",
            durableGlobalEventQueue: true,
        });
        try {
            const session = await store.create({ cwd: "/tmp/rig-live-vs-durable" });
            await session.setDraft({ draft: "typed", updatedAt: Date.now() });

            const durable = (await store.globalEventQueue.list()) ?? [];
            expect(durable.some((entry) => entry.event.type === "session_draft_changed")).toBe(
                false,
            );
        } finally {
            await store.close();
        }
    });
});
