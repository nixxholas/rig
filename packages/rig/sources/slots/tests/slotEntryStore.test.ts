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
        let store = await PersistentSessionStore.open({ databasePath });
        cleanups.push(() => store.close());
        const entry = await store.slots.create({
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
        await store.close();

        store = await PersistentSessionStore.open({ databasePath });
        const restored = await store.slots.list();
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
        const store = await PersistentSessionStore.open({ databasePath: ":memory:" });
        cleanups.push(() => store.close());
        const valid = {
            author: { type: "agent", sessionId: "session-1" },
            content: { markdown: "hi", type: "text" },
            description: "d",
            purpose: "p",
            scope: "everywhere",
            slot: "status-line",
        } as const;
        await expect(store.slots.create({ ...valid, slot: "footer" as never })).rejects.toThrow(
            SlotEntryInvalidError,
        );
        await expect(store.slots.create({ ...valid, scope: "galaxy" as never })).rejects.toThrow(
            SlotEntryInvalidError,
        );
        await expect(
            store.slots.create({ ...valid, content: { type: "video", url: "x" } as never }),
        ).rejects.toThrow(SlotEntryInvalidError);
        await expect(
            store.slots.create({
                ...valid,
                content: {
                    action: { type: "send-current-chat" },
                    label: "Go",
                    type: "button",
                } as never,
            }),
        ).rejects.toThrow(SlotEntryInvalidError);
        await expect(
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
        ).rejects.toThrow(SlotEntryInvalidError);
        expect(await store.slots.list()).toHaveLength(0);
    });

    it("requires exactly the scope reference matching the scope, pointing at a real target", async () => {
        const store = await PersistentSessionStore.open({ databasePath: ":memory:" });
        cleanups.push(() => store.close());
        const valid = {
            author: { type: "agent", sessionId: "session-1" },
            content: { markdown: "hi", type: "text" },
            description: "d",
            purpose: "p",
        } as const;
        await expect(
            store.slots.create({ ...valid, scope: "project", slot: "title" }),
        ).rejects.toThrow(SlotEntryInvalidError);
        await expect(
            store.slots.create({
                ...valid,
                projectId: "missing-project",
                scope: "project",
                slot: "title",
            }),
        ).rejects.toThrow(SlotEntryInvalidError);
        await expect(
            store.slots.create({
                ...valid,
                scope: "everywhere",
                sessionId: "some-session",
                slot: "status-line",
            }),
        ).rejects.toThrow(SlotEntryInvalidError);
    });

    it("accepts and rejects representative slot and scope combinations", async () => {
        const databasePath = await createDatabasePath();
        await createSessionDatabaseFixture(databasePath);
        const store = await PersistentSessionStore.open({ databasePath });
        cleanups.push(() => store.close());
        const common = {
            author: { type: "agent", sessionId: "session-1" },
            content: { markdown: "hi", type: "text" },
            description: "d",
            purpose: "p",
        } as const;

        expect(
            await store.slots.create({
                ...common,
                scope: "everywhere",
                slot: "sidebar",
            }),
        ).toMatchObject({ scope: "everywhere", slot: "sidebar" });
        expect(
            await store.slots.create({
                ...common,
                projectId: "project-1",
                scope: "project",
                slot: "title",
            }),
        ).toMatchObject({ scope: "project", slot: "title" });
        expect(
            await store.slots.create({
                ...common,
                scope: "session",
                sessionId: "session-1",
                slot: "status-line",
            }),
        ).toMatchObject({ scope: "session", slot: "status-line" });
        expect(
            await store.slots.create({
                ...common,
                projectId: "project-1",
                scope: "project",
                slot: "above-composer",
            }),
        ).toMatchObject({ scope: "project", slot: "above-composer" });

        await expect(
            store.slots.create({
                ...common,
                scope: "session",
                sessionId: "session-1",
                slot: "sidebar",
            }),
        ).rejects.toThrow("The sidebar slot allows only the everywhere scope.");
        await expect(
            store.slots.create({
                ...common,
                scope: "everywhere",
                slot: "title",
            }),
        ).rejects.toThrow("The title slot allows only the project and workspace scopes.");
    });

    it("rejects moving an entry to a slot incompatible with its fixed scope", async () => {
        const databasePath = await createDatabasePath();
        await createSessionDatabaseFixture(databasePath);
        const store = await PersistentSessionStore.open({ databasePath });
        cleanups.push(() => store.close());
        const entry = await store.slots.create({
            author: { type: "agent", sessionId: "session-1" },
            content: { markdown: "hi", type: "text" },
            description: "d",
            purpose: "p",
            scope: "session",
            sessionId: "session-1",
            slot: "status-line",
        });

        await expect(store.slots.update(entry.id, { slot: "sidebar" })).rejects.toThrow(
            "The sidebar slot allows only the everywhere scope.",
        );
        expect(await store.slots.list()).toEqual([entry]);
    });

    it("rejects creating or updating an applet button whose scope the applet disallows", async () => {
        const databasePath = await createDatabasePath();
        await createSessionDatabaseFixture(databasePath);
        const opened = await openSessionDatabase(databasePath);
        await appletCreate(opened.database, {
            allowedScopes: ["session"],
            authorSessionId: "session-1",
            changeDescription: "Initial import",
            createdAt: 1,
            description: "A dashboard",
            iconThumbhash: "thumbhash",
            name: "dashboard",
            purpose: "Track work",
        });
        await opened.client.close();
        const store = await PersistentSessionStore.open({ databasePath });
        cleanups.push(() => store.close());
        const appletButton = {
            action: { type: "open-applet", applet: "dashboard" },
            label: "Open dashboard",
            type: "button",
        } as const;

        await expect(
            store.slots.create({
                author: { type: "agent", sessionId: "session-1" },
                content: appletButton,
                description: "Dashboard",
                purpose: "Track work",
                scope: "everywhere",
                slot: "status-line",
            }),
        ).rejects.toThrow(
            'The applet "dashboard" does not allow the everywhere scope. It allows only the session scope.',
        );

        const entry = await store.slots.create({
            author: { type: "agent", sessionId: "session-1" },
            content: { markdown: "hi", type: "text" },
            description: "Dashboard",
            purpose: "Track work",
            scope: "everywhere",
            slot: "status-line",
        });
        await expect(store.slots.update(entry.id, { content: appletButton })).rejects.toThrow(
            SlotEntryInvalidError,
        );
    });

    it("allows description-only updates of legacy entries with incompatible slot scopes", async () => {
        const databasePath = await createDatabasePath();
        await createSessionDatabaseFixture(databasePath);
        const opened = await openSessionDatabase(databasePath);
        await slotEntryCreate(opened.database, {
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
        await opened.client.close();
        const store = await PersistentSessionStore.open({ databasePath });
        cleanups.push(() => store.close());

        expect(
            await store.slots.update("legacy-entry", { description: "new description" }),
        ).toMatchObject({
            description: "new description",
            id: "legacy-entry",
            scope: "session",
            slot: "sidebar",
        });
    });

    it("updates and removes entries and publishes the whole set on every change", async () => {
        const store = await PersistentSessionStore.open({ databasePath: ":memory:" });
        cleanups.push(() => store.close());
        const events: GlobalLiveEvent[] = [];
        store.liveEvents.subscribe((delivery) => {
            if (delivery.event.type === "slots_changed") events.push(delivery.event);
        });
        const entry = await store.slots.create({
            author: { type: "agent", sessionId: "session-1" },
            content: { markdown: "hi", type: "text" },
            description: "d",
            purpose: "p",
            scope: "everywhere",
            slot: "above-composer",
        });
        const updated = await store.slots.update(entry.id, {
            content: {
                action: { message: "Run the checks", type: "send-current-chat" },
                label: "Run checks",
                type: "button",
            },
        });
        expect(updated.content.type).toBe("button");
        await expect(store.slots.update("missing", { description: "x" })).rejects.toThrow(
            SlotEntryNotFoundError,
        );
        await store.slots.remove(entry.id);
        await expect(store.slots.remove(entry.id)).rejects.toThrow(SlotEntryNotFoundError);
        expect(await store.slots.list()).toHaveLength(0);
        expect(events).toHaveLength(3);
        expect(events.at(-1)?.data).toEqual({ entries: [] });
    });
});

async function createDatabasePath(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "rig-slots-test-"));
    cleanups.push(() => rm(directory, { force: true, recursive: true }));
    return join(directory, "sessions.sqlite");
}
