import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { GlobalLiveEvent } from "../../protocol/index.js";
import { PersistentSessionStore } from "../../session/PersistentSessionStore.js";
import { SlotEntryInvalidError } from "../SlotEntryInvalidError.js";
import { SlotEntryNotFoundError } from "../SlotEntryNotFoundError.js";

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("slot entry store", () => {
    it("persists entries across a store restart", async () => {
        const databasePath = await createDatabasePath();
        let store = new PersistentSessionStore({ databasePath });
        cleanups.push(() => store.close());
        const entry = store.slots.create({
            authorSessionId: "session-1",
            content: { markdown: "**Build passing**", type: "text" },
            description: "Build status line",
            purpose: "Shows CI health at a glance",
            scope: "everywhere",
            slot: "status-line",
        });
        expect(entry.id).toBeTruthy();
        store.close();

        store = new PersistentSessionStore({ databasePath });
        const restored = store.slots.list();
        expect(restored).toHaveLength(1);
        expect(restored[0]).toMatchObject({
            authorSessionId: "session-1",
            content: { markdown: "**Build passing**", type: "text" },
            description: "Build status line",
            id: entry.id,
            purpose: "Shows CI health at a glance",
            scope: "everywhere",
            slot: "status-line",
        });
    });

    it("rejects unknown slots, scopes, content types, and malformed actions", async () => {
        const store = new PersistentSessionStore({ databasePath: ":memory:" });
        cleanups.push(() => store.close());
        const valid = {
            authorSessionId: "session-1",
            content: { markdown: "hi", type: "text" },
            description: "d",
            purpose: "p",
            scope: "everywhere",
            slot: "status-line",
        } as const;
        expect(() => store.slots.create({ ...valid, slot: "footer" as never })).toThrow(
            SlotEntryInvalidError,
        );
        expect(() => store.slots.create({ ...valid, scope: "galaxy" as never })).toThrow(
            SlotEntryInvalidError,
        );
        expect(() =>
            store.slots.create({ ...valid, content: { type: "video", url: "x" } as never }),
        ).toThrow(SlotEntryInvalidError);
        expect(() =>
            store.slots.create({
                ...valid,
                content: {
                    action: { type: "send-current-chat" },
                    label: "Go",
                    type: "button",
                } as never,
            }),
        ).toThrow(SlotEntryInvalidError);
        expect(store.slots.list()).toHaveLength(0);
    });

    it("requires exactly the scope reference matching the scope, pointing at a real target", async () => {
        const store = new PersistentSessionStore({ databasePath: ":memory:" });
        cleanups.push(() => store.close());
        const valid = {
            authorSessionId: "session-1",
            content: { markdown: "hi", type: "text" },
            description: "d",
            purpose: "p",
        } as const;
        expect(() => store.slots.create({ ...valid, scope: "project", slot: "title" })).toThrow(
            SlotEntryInvalidError,
        );
        expect(() =>
            store.slots.create({
                ...valid,
                projectId: "missing-project",
                scope: "project",
                slot: "title",
            }),
        ).toThrow(SlotEntryInvalidError);
        expect(() =>
            store.slots.create({
                ...valid,
                scope: "everywhere",
                sessionId: "some-session",
                slot: "title",
            }),
        ).toThrow(SlotEntryInvalidError);
    });

    it("updates and removes entries and publishes the whole set on every change", async () => {
        const store = new PersistentSessionStore({ databasePath: ":memory:" });
        cleanups.push(() => store.close());
        const events: GlobalLiveEvent[] = [];
        store.liveEvents.subscribe((delivery) => {
            if (delivery.event.type === "slots_changed") events.push(delivery.event);
        });
        const entry = store.slots.create({
            authorSessionId: "session-1",
            content: { markdown: "hi", type: "text" },
            description: "d",
            purpose: "p",
            scope: "everywhere",
            slot: "above-composer",
        });
        const updated = store.slots.update(entry.id, {
            content: {
                action: { message: "Run the checks", type: "send-current-chat" },
                label: "Run checks",
                type: "button",
            },
        });
        expect(updated.content.type).toBe("button");
        expect(() => store.slots.update("missing", { description: "x" })).toThrow(
            SlotEntryNotFoundError,
        );
        store.slots.remove(entry.id);
        expect(() => store.slots.remove(entry.id)).toThrow(SlotEntryNotFoundError);
        expect(store.slots.list()).toHaveLength(0);
        expect(events).toHaveLength(3);
        expect(events.at(-1)?.data).toEqual({ entries: [] });
    });
});

async function createDatabasePath(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "rig-slots-test-"));
    cleanups.push(() => rm(directory, { force: true, recursive: true }));
    return join(directory, "sessions.sqlite");
}
