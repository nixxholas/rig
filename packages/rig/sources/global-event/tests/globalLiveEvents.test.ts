import { afterEach, describe, expect, it } from "vitest";
import type { Client } from "@libsql/client";
import { trace, type Context as OtelContext, type Span, type Tracer } from "@opentelemetry/api";

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
import { createTestRootContext } from "../../testing/createTestRootContext.js";

const clients: Client[] = [];

afterEach(async () => {
    for (const client of clients.splice(0)) await client.close();
});

describe("live global events", () => {
    for (const [name, create] of [
        [
            "in-memory",
            () => ({ ctx: createTestRootContext(), queue: new InMemoryGlobalEventQueue() }),
        ],
        [
            "durable",
            async () => {
                const rootCtx = createTestRootContext();
                const opened = await openSessionDatabase(rootCtx, ":memory:");
                clients.push(opened.client);
                await migrateSessionDatabase(opened.ctx);
                return {
                    ctx: opened.ctx,
                    queue: await PersistentGlobalEventQueue.open(rootCtx, opened.database),
                };
            },
        ],
    ] as const) {
        describe(name, () => {
            it("delivers a live event without storing it or advancing the cursor", async () => {
                const { ctx, queue } = await create();
                const delivered: GlobalEventDelivery[] = [];
                queue.subscribe((delivery) => delivered.push(delivery));
                const before = queue.cursor();

                queue.publishLive(liveEvent());

                expect(delivered).toHaveLength(1);
                expect(delivered[0]).toMatchObject({ live: true });
                expect(queue.cursor()).toBe(before);
                // A replay from the beginning must not contain it, or a reconnecting client would
                // receive a snapshot that no longer reflects the repository.
                expect(await queue.list(ctx)).toEqual([]);
            });

            it("keeps stored events replayable alongside live ones", async () => {
                const { ctx, queue } = await create();
                const entry = await queue.append(ctx, {
                    createdAt: 1,
                    data: { project: { id: "p1" } as never },
                    id: "e1" as never,
                    projectId: "p1",
                    type: "project_created",
                });
                queue.publishLive(liveEvent());

                expect((await queue.list(ctx))?.map((stored) => stored.cursor)).toEqual([
                    entry?.cursor,
                ]);
            });

            it("keeps delivering stored events after one subscriber throws", async () => {
                const { ctx, queue } = await create();
                const delivered: GlobalEventDelivery[] = [];
                queue.subscribe(() => {
                    throw new Error("subscriber failed");
                });
                queue.subscribe((delivery) => delivered.push(delivery));
                const entry = await queue.append(ctx, {
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
        const rootCtx = createTestRootContext();
        const opened = await openSessionDatabase(rootCtx, ":memory:");
        clients.push(opened.client);
        await migrateSessionDatabase(opened.ctx);
        const queue = await PersistentGlobalEventQueue.open(rootCtx, opened.database);
        const before = queue.cursor();
        const event = {
            createdAt: 1,
            data: { project: { id: "p1" } as never },
            id: "rolled-back-event" as never,
            projectId: "p1",
            type: "project_created" as const,
        };

        await expect(
            inTx(opened.ctx, "rig.sql.global_event.test_rollback", async (ctx) => {
                expect((await queue.append(ctx, event))?.event).toBe(event);
                throw new Error("roll back caller");
            }),
        ).rejects.toThrow("roll back caller");

        expect(queue.cursor()).toBe(before);
        expect(await queue.list(opened.ctx)).toEqual([]);
    });

    it("keeps the caller trace as the parent of durable SQL", async () => {
        const traced = recordingContext();
        const opened = await openSessionDatabase(traced.ctx, ":memory:");
        clients.push(opened.client);
        await migrateSessionDatabase(opened.ctx);
        const queue = await PersistentGlobalEventQueue.open(traced.ctx, opened.database);
        traced.calls.length = 0;

        await traced.ctx.span("test.global_events.caller", (ctx) => queue.list(ctx));

        const caller = traced.calls.find((call) => call.name === "test.global_events.caller");
        const query = traced.calls.find((call) => call.name === "rig.sql.global_events.query");
        expect(query?.parentSpanId).toBe(caller?.spanId);
    });

    it("retains compute preparation events in the durable stream", async () => {
        const rootCtx = createTestRootContext();
        const opened = await openSessionDatabase(rootCtx, ":memory:");
        clients.push(opened.client);
        await migrateSessionDatabase(opened.ctx);
        const queue = await PersistentGlobalEventQueue.open(rootCtx, opened.database);
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

        const appended = await queue.append(opened.ctx, event);

        expect(appended?.event).toBe(event);
        expect(
            await PersistentGlobalEventQueue.open(rootCtx, opened.database).then((next) =>
                next.list(rootCtx),
            ),
        ).toEqual([
            expect.objectContaining({
                event,
            }),
        ]);
    });

    it("stores folder and document events under their own aggregates", async () => {
        const rootCtx = createTestRootContext();
        const opened = await openSessionDatabase(rootCtx, ":memory:");
        clients.push(opened.client);
        await migrateSessionDatabase(opened.ctx);
        const queue = await PersistentGlobalEventQueue.open(rootCtx, opened.database);
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

        await queue.append(opened.ctx, documentEvent);
        await queue.append(opened.ctx, folderEvent);

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

function recordingContext(): {
    calls: Array<{ name: string; parentSpanId?: string; spanId: string }>;
    ctx: ReturnType<typeof createTestRootContext>;
} {
    const calls: Array<{ name: string; parentSpanId?: string; spanId: string }> = [];
    let nextSpanId = 0;
    const tracer = {
        startSpan: (name: string, _options: unknown, parent: OtelContext) => {
            nextSpanId += 1;
            const spanId = nextSpanId.toString(16).padStart(16, "0");
            const parentSpanId = trace.getSpan(parent)?.spanContext().spanId;
            calls.push({ name, ...(parentSpanId === undefined ? {} : { parentSpanId }), spanId });
            return {
                end: () => undefined,
                recordException: () => undefined,
                setStatus: () => undefined,
                spanContext: () => ({
                    spanId,
                    traceFlags: 1,
                    traceId: "1".repeat(32),
                }),
            } as unknown as Span;
        },
    } as unknown as Tracer;
    return { calls, ctx: createTestRootContext(tracer) };
}
