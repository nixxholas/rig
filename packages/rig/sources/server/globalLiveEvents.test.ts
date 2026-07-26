import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import type { GitChangeSnapshot, GlobalEventDelivery, GlobalLiveEvent } from "../protocol/index.js";
import { InMemoryGlobalEventQueue } from "./InMemoryGlobalEventQueue.js";
import { initializeSessionDatabase } from "./initializeSessionDatabase.js";
import { PersistentGlobalEventQueue } from "./PersistentGlobalEventQueue.js";
import { shouldPublishGlobalEvent } from "./shouldPublishGlobalEvent.js";

describe("live global events", () => {
    for (const [name, create] of [
        ["in-memory", () => new InMemoryGlobalEventQueue()],
        [
            "durable",
            () => {
                const database = new DatabaseSync(":memory:");
                initializeSessionDatabase(database);
                return new PersistentGlobalEventQueue(database);
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
