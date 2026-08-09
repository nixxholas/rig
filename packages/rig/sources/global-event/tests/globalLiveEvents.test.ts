import { afterEach, describe, expect, it } from "vitest";
import type { Client } from "@libsql/client";

import type {
    ComputePreparationEvent,
    DocumentEvent,
    FolderEvent,
    GitChangeSnapshot,
    GlobalEventDelivery,
    GlobalLiveEvent,
} from "../../protocol/index.js";
import { inTx } from "../../persistence/inTx.js";
import { migrateSessionDatabase } from "../../persistence/database/migrateSessionDatabase.js";
import { openSessionDatabase } from "../../persistence/database/openSessionDatabase.js";
import { InMemoryGlobalEventQueue } from "../InMemoryGlobalEventQueue.js";
import { PersistentGlobalEventQueue } from "../PersistentGlobalEventQueue.js";
import { shouldPublishGlobalEvent } from "../shouldPublishGlobalEvent.js";

const clients: Client[] = [];

afterEach(async () => {
    for (const client of clients.splice(0)) await client.close();
});

describe("live global events", () => {
    for (const [name, create] of [
        ["in-memory", () => new InMemoryGlobalEventQueue()],
        [
            "durable",
            async () => {
                const opened = await openSessionDatabase(":memory:");
                clients.push(opened.client);
                await migrateSessionDatabase(opened.database);
                return PersistentGlobalEventQueue.open(opened.database);
            },
        ],
    ] as const) {
        describe(name, () => {
            it("delivers a live event without storing it or advancing the cursor", async () => {
                const queue = await create();
                const delivered: GlobalEventDelivery[] = [];
                queue.subscribe((delivery) => delivered.push(delivery));
                const before = queue.cursor();

                queue.publishLive(liveEvent());

                expect(delivered).toHaveLength(1);
                expect(delivered[0]).toMatchObject({ live: true });
                expect(queue.cursor()).toBe(before);
                // A replay from the beginning must not contain it, or a reconnecting client would
                // receive a snapshot that no longer reflects the repository.
                expect(await queue.list()).toEqual([]);
            });

            it("keeps stored events replayable alongside live ones", async () => {
                const queue = await create();
                const entry = await queue.append({
                    createdAt: 1,
                    data: { project: { id: "p1" } as never },
                    id: "e1" as never,
                    projectId: "p1",
                    type: "project_created",
                });
                queue.publishLive(liveEvent());

                expect((await queue.list())?.map((stored) => stored.cursor)).toEqual([
                    entry?.cursor,
                ]);
            });

            it("keeps delivering stored events after one subscriber throws", async () => {
                const queue = await create();
                const delivered: GlobalEventDelivery[] = [];
                queue.subscribe(() => {
                    throw new Error("subscriber failed");
                });
                queue.subscribe((delivery) => delivered.push(delivery));
                const entry = await queue.append({
                    createdAt: 1,
                    data: { project: { id: "p1" } as never },
                    id: "e1" as never,
                    projectId: "p1",
                    type: "project_created",
                });
                if (entry === undefined) throw new Error("Expected a stored event.");

                queue.publish(entry);

                expect(delivered).toEqual([entry]);
            });
        });
    }

    it("never routes a Git snapshot into the stored stream", () => {
        // The publish path treats an append that returns nothing as "do not publish", so live
        // events have to be excluded before they ever reach it.
        expect(shouldPublishGlobalEvent(liveEvent())).toBe(false);
        expect(
            shouldPublishGlobalEvent({
                createdAt: 1,
                data: { project: { id: "p1" } as never },
                id: "e1" as never,
                projectId: "p1",
                type: "project_created",
            }),
        ).toBe(true);
    });

    it("rolls a durable append back with its caller transaction", async () => {
        const opened = await openSessionDatabase(":memory:");
        clients.push(opened.client);
        await migrateSessionDatabase(opened.database);
        const queue = await PersistentGlobalEventQueue.open(opened.database);
        const before = queue.cursor();
        const event = {
            createdAt: 1,
            data: { project: { id: "p1" } as never },
            id: "rolled-back-event" as never,
            projectId: "p1",
            type: "project_created" as const,
        };

        await expect(
            inTx(opened.database, async (tx) => {
                expect((await queue.append(event, tx))?.event).toBe(event);
                expect(await queue.list()).toHaveLength(1);
                throw new Error("roll back caller");
            }),
        ).rejects.toThrow("roll back caller");

        expect(queue.cursor()).toBe(before);
        expect(await queue.list()).toEqual([]);
    });

    it("retains compute preparation events in the durable stream", async () => {
        const opened = await openSessionDatabase(":memory:");
        clients.push(opened.client);
        await migrateSessionDatabase(opened.database);
        const queue = await PersistentGlobalEventQueue.open(opened.database);
        const event: ComputePreparationEvent = {
            computeInstanceId: "compute-1",
            createdAt: 1,
            data: {
                message: "Copying files to compute.",
                phase: "copying_files_to_compute",
                provider: "test-compute",
                state: "provisioning",
            },
            id: "compute-event-1" as never,
            type: "compute_preparation",
        };

        const appended = await queue.append(event);

        expect(appended?.event).toBe(event);
        expect(
            await PersistentGlobalEventQueue.open(opened.database).then((next) => next.list()),
        ).toEqual([
            expect.objectContaining({
                event,
            }),
        ]);
    });

    it("stores folder and document events under their own aggregates", async () => {
        const opened = await openSessionDatabase(":memory:");
        clients.push(opened.client);
        await migrateSessionDatabase(opened.database);
        const queue = await PersistentGlobalEventQueue.open(opened.database);
        const documentEvent: DocumentEvent = {
            createdAt: 1,
            data: { documentId: "document-1", version: 2 },
            id: "document-event-1" as never,
            type: "document_changed",
        };
        const folderEvent: FolderEvent = {
            createdAt: 2,
            data: { revision: 3 },
            id: "folder-event-1" as never,
            type: "folders_changed",
        };

        await queue.append(documentEvent);
        await queue.append(folderEvent);

        expect(
            (
                await opened.client.execute(
                    "SELECT aggregate_id AS aggregateId, aggregate_kind AS aggregateKind FROM durable_global_events WHERE type = 'document_changed'",
                )
            ).rows[0],
        ).toEqual({ aggregateId: "document-1", aggregateKind: "document" });
        expect(
            (
                await opened.client.execute(
                    "SELECT aggregate_id AS aggregateId, aggregate_kind AS aggregateKind FROM durable_global_events WHERE type = 'folders_changed'",
                )
            ).rows[0],
        ).toEqual({ aggregateId: "catalog", aggregateKind: "folder" });
    });
});

function liveEvent(): GlobalLiveEvent {
    return {
        createdAt: 1,
        data: { git: snapshot() },
        id: "live-1" as never,
        projectId: "p1",
        type: "project_git_changed",
    };
}

function snapshot(): GitChangeSnapshot {
    return {
        changedFiles: 1,
        comparison: "ready",
        conflicted: false,
        countsExact: true,
        deletions: 0,
        facts: { ahead: 0, behind: 0, detached: false },
        files: [],
        filesTruncated: false,
        generation: "gen-1",
        insertions: 4,
        scannedAt: 1,
        version: 1,
    };
}
