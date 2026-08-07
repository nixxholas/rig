import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createSessionDatabaseFixture } from "../../persistence/database/tests/createSessionDatabaseFixture.js";
import { openSessionDatabase } from "../../persistence/database/openSessionDatabase.js";
import { slotEntryCreate } from "../../persistence/slots/slotEntryCreate.js";
import { appletCreate } from "../../persistence/applets/appletCreate.js";
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
            author: { type: "agent", sessionId: "session-1" },
            content: {
                action: {
                    path: "reports/today.html",
                    query: { theme: "dark", view: "compact" },
                    type: "open-applet",
                    applet: "build-dashboard",
                },
                label: "View build",
                type: "button",
            },
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
            author: { type: "agent", sessionId: "session-1" },
            content: {
                action: {
                    path: "reports/today.html",
                    query: { theme: "dark", view: "compact" },
                    type: "open-applet",
                    applet: "build-dashboard",
                },
                label: "View build",
                type: "button",
            },
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
            author: { type: "agent", sessionId: "session-1" },
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
        expect(() =>
            store.slots.create({
                ...valid,
                content: {
                    action: {
                        query: { report: 1 },
                        type: "open-applet",
                        applet: "build-dashboard",
                    },
                    label: "View build",
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
            author: { type: "agent", sessionId: "session-1" },
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
                slot: "status-line",
            }),
        ).toThrow(SlotEntryInvalidError);
    });

    it("accepts and rejects representative slot and scope combinations", async () => {
        const databasePath = await createDatabasePath();
        createSessionDatabaseFixture(databasePath);
        const store = new PersistentSessionStore({ databasePath });
        cleanups.push(() => store.close());
        const common = {
            author: { type: "agent", sessionId: "session-1" },
            content: { markdown: "hi", type: "text" },
            description: "d",
            purpose: "p",
        } as const;

        expect(
            store.slots.create({
                ...common,
                scope: "everywhere",
                slot: "sidebar",
            }),
        ).toMatchObject({ scope: "everywhere", slot: "sidebar" });
        expect(
            store.slots.create({
                ...common,
                projectId: "project-1",
                scope: "project",
                slot: "title",
            }),
        ).toMatchObject({ scope: "project", slot: "title" });
        expect(
            store.slots.create({
                ...common,
                scope: "session",
                sessionId: "session-1",
                slot: "status-line",
            }),
        ).toMatchObject({ scope: "session", slot: "status-line" });
        expect(
            store.slots.create({
                ...common,
                projectId: "project-1",
                scope: "project",
                slot: "above-composer",
            }),
        ).toMatchObject({ scope: "project", slot: "above-composer" });

        expect(() =>
            store.slots.create({
                ...common,
                scope: "session",
                sessionId: "session-1",
                slot: "sidebar",
            }),
        ).toThrow("The sidebar slot allows only the everywhere scope.");
        expect(() =>
            store.slots.create({
                ...common,
                scope: "everywhere",
                slot: "title",
            }),
        ).toThrow("The title slot allows only the project and workspace scopes.");
    });

    it("rejects moving an entry to a slot incompatible with its fixed scope", async () => {
        const databasePath = await createDatabasePath();
        createSessionDatabaseFixture(databasePath);
        const store = new PersistentSessionStore({ databasePath });
        cleanups.push(() => store.close());
        const entry = store.slots.create({
            author: { type: "agent", sessionId: "session-1" },
            content: { markdown: "hi", type: "text" },
            description: "d",
            purpose: "p",
            scope: "session",
            sessionId: "session-1",
            slot: "status-line",
        });

        expect(() => store.slots.update(entry.id, { slot: "sidebar" })).toThrow(
            "The sidebar slot allows only the everywhere scope.",
        );
        expect(store.slots.list()).toEqual([entry]);
    });

    it("rejects creating or updating an applet button whose scope the applet disallows", async () => {
        const databasePath = await createDatabasePath();
        createSessionDatabaseFixture(databasePath);
        const opened = openSessionDatabase(databasePath);
        appletCreate(opened.database, {
            allowedScopes: ["session"],
            authorSessionId: "session-1",
            changeDescription: "Initial import",
            createdAt: 1,
            description: "A dashboard",
            iconThumbhash: "thumbhash",
            name: "dashboard",
            purpose: "Track work",
        });
        opened.client.close();
        const store = new PersistentSessionStore({ databasePath });
        cleanups.push(() => store.close());
        const appletButton = {
            action: { type: "open-applet", applet: "dashboard" },
            label: "Open dashboard",
            type: "button",
        } as const;

        expect(() =>
            store.slots.create({
                author: { type: "agent", sessionId: "session-1" },
                content: appletButton,
                description: "Dashboard",
                purpose: "Track work",
                scope: "everywhere",
                slot: "status-line",
            }),
        ).toThrow(
            'The applet "dashboard" does not allow the everywhere scope. It allows only the session scope.',
        );

        const entry = store.slots.create({
            author: { type: "agent", sessionId: "session-1" },
            content: { markdown: "hi", type: "text" },
            description: "Dashboard",
            purpose: "Track work",
            scope: "everywhere",
            slot: "status-line",
        });
        expect(() => store.slots.update(entry.id, { content: appletButton })).toThrow(
            SlotEntryInvalidError,
        );
    });

    it("allows description-only updates of legacy entries with incompatible slot scopes", async () => {
        const databasePath = await createDatabasePath();
        createSessionDatabaseFixture(databasePath);
        const opened = openSessionDatabase(databasePath);
        slotEntryCreate(opened.database, {
            author: { type: "agent", sessionId: "session-1" },
            content: { markdown: "hi", type: "text" },
            createdAt: 1,
            description: "old description",
            id: "legacy-entry",
            purpose: "p",
            scope: "session",
            sessionId: "session-1",
            slot: "sidebar",
            updatedAt: 1,
        });
        opened.client.close();
        const store = new PersistentSessionStore({ databasePath });
        cleanups.push(() => store.close());

        expect(
            store.slots.update("legacy-entry", { description: "new description" }),
        ).toMatchObject({
            description: "new description",
            id: "legacy-entry",
            scope: "session",
            slot: "sidebar",
        });
    });

    it("updates and removes entries and publishes the whole set on every change", async () => {
        const store = new PersistentSessionStore({ databasePath: ":memory:" });
        cleanups.push(() => store.close());
        const events: GlobalLiveEvent[] = [];
        store.liveEvents.subscribe((delivery) => {
            if (delivery.event.type === "slots_changed") events.push(delivery.event);
        });
        const entry = store.slots.create({
            author: { type: "agent", sessionId: "session-1" },
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
