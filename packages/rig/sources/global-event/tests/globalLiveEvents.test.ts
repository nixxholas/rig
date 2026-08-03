import { afterEach, describe, expect, it } from "vitest";

import type {
    ComputePreparationEvent,
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

const clients: ReturnType<typeof openSessionDatabase>["client"][] = [];

afterEach(() => {
    for (const client of clients.splice(0)) client.close();
});

describe("live global events", () => {
    for (const [name, create] of [
        ["in-memory", () => new InMemoryGlobalEventQueue()],
        [
            "durable",
            () => {
                const opened = openSessionDatabase(":memory:");
                clients.push(opened.client);
                migrateSessionDatabase(opened.database);
                return new PersistentGlobalEventQueue(opened.database);
            },
        ],
    ] as const) {
        describe(name, () => {
            it("delivers a live event without storing it or advancing the cursor", () => {
                const queue = create();
                const delivered: GlobalEventDelivery[] = [];
                queue.subscribe((delivery) => delivered.push(delivery));
                const before = queue.cursor();

                queue.publishLive(liveEvent());

                expect(delivered).toHaveLength(1);
                expect(delivered[0]).toMatchObject({ live: true });
                expect(queue.cursor()).toBe(before);
                // A replay from the beginning must not contain it, or a reconnecting client would
                // receive a snapshot that no longer reflects the repository.
                expect(queue.list()).toEqual([]);
            });

            it("keeps stored events replayable alongside live ones", () => {
                const queue = create();
                const entry = queue.append({
                    createdAt: 1,
                    data: { project: { id: "p1" } as never },
                    id: "e1" as never,
                    projectId: "p1",
                    type: "project_created",
                });
                queue.publishLive(liveEvent());

                expect(queue.list()?.map((stored) => stored.cursor)).toEqual([entry?.cursor]);
            });

            it("keeps delivering stored events after one subscriber throws", () => {
                const queue = create();
                const delivered: GlobalEventDelivery[] = [];
                queue.subscribe(() => {
                    throw new Error("subscriber failed");
                });
                queue.subscribe((delivery) => delivered.push(delivery));
                const entry = queue.append({
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

    it("rolls a durable append back with its caller transaction", () => {
        const opened = openSessionDatabase(":memory:");
        clients.push(opened.client);
        migrateSessionDatabase(opened.database);
        const queue = new PersistentGlobalEventQueue(opened.database);
        const before = queue.cursor();
        const event = {
            createdAt: 1,
            data: { project: { id: "p1" } as never },
            id: "rolled-back-event" as never,
            projectId: "p1",
            type: "project_created" as const,
        };

        expect(() =>
            inTx(opened.database, (tx) => {
                expect(queue.append(event, tx)?.event).toBe(event);
                expect(queue.list()).toHaveLength(1);
                throw new Error("roll back caller");
            }),
        ).toThrow("roll back caller");

        expect(queue.cursor()).toBe(before);
        expect(queue.list()).toEqual([]);
    });

    it("retains compute preparation events in the durable stream", () => {
        const opened = openSessionDatabase(":memory:");
        clients.push(opened.client);
        migrateSessionDatabase(opened.database);
        const queue = new PersistentGlobalEventQueue(opened.database);
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

        const appended = queue.append(event);

        expect(appended?.event).toBe(event);
        expect(new PersistentGlobalEventQueue(opened.database).list()).toEqual([
            expect.objectContaining({
                event,
            }),
        ]);
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
