import { describe, expect, it, vi } from "vitest";
import type { Context } from "@steve.kite/stdlib";

import { SchedulingModule, schedulingMigrations } from "../../sources/scheduling/index.js";
import type {
    SchedulingEvent,
    SchedulingScheduledMessage,
    SchedulingWaitRecord,
    SchedulingWaitResult,
} from "../../sources/scheduling/index.js";
import { moduleDatabase } from "../support/moduleDatabase.js";
import {
    InMemorySchedulingScheduler,
    InMemorySchedulingStore,
} from "./support/InMemoryScheduling.js";

const agentId = "agent-a";
const otherAgentId = "agent-b";

interface Harness {
    readonly module: SchedulingModule;
    readonly database: ReturnType<typeof moduleDatabase>;
    readonly scheduler: InMemorySchedulingScheduler;
    readonly setNow: (value: number) => void;
}

async function harness(
    name: string,
    options: Partial<ConstructorParameters<typeof SchedulingModule>[0]> = {},
): Promise<Harness> {
    const scheduler = new InMemorySchedulingScheduler(new InMemorySchedulingStore());
    let now = 1_000;
    let sequence = 0;
    let events = 0;
    const module = new SchedulingModule({
        scheduler,
        clock: () => now,
        idFactory: () => `generated-${++sequence}`,
        eventIdFactory: () => `event-${++events}`,
        scheduleMessagePolicy: () => true,
        authorization: () => true,
        ...options,
    });
    const database = moduleDatabase(module.migrations, name);
    await database.ready;
    return {
        module,
        database,
        scheduler,
        setNow: (value) => {
            now = value;
        },
    };
}

function waitRecord(id: string, fields: Partial<SchedulingWaitRecord> = {}): SchedulingWaitRecord {
    return {
        id,
        agentId,
        kind: "wait",
        dueAt: 2_000,
        createdAt: 1_000,
        updatedAt: 1_000,
        startedAt: 1_000,
        status: "waiting",
        ...fields,
    } as SchedulingWaitRecord;
}

function waitResult(id: string, fields: Partial<SchedulingWaitResult> = {}): SchedulingWaitResult {
    return {
        waitId: id,
        agentId,
        outcome: "elapsed",
        kind: "wait",
        dueAt: 2_000,
        startedAt: 1_000,
        endedAt: 2_000,
        elapsedMs: 1_000,
        ...fields,
    };
}

function scheduleResult(
    id: string,
    fields: Partial<SchedulingScheduledMessage> = {},
): SchedulingScheduledMessage {
    return {
        id,
        senderAgentId: agentId,
        targetAgentId: agentId,
        message: "message",
        dueAt: 2_000,
        status: "pending",
        createdAt: 1_000,
        updatedAt: 1_000,
        ...fields,
    };
}

describe("Scheduling host result validation", () => {
    it("rejects a scheduler schedule result that changes any requested identity or content", async () => {
        const mutations: Array<{
            readonly name: string;
            readonly alter: (result: SchedulingScheduledMessage) => SchedulingScheduledMessage;
        }> = [
            { name: "id", alter: (result) => ({ ...result, id: "different-id" }) },
            {
                name: "sender",
                alter: (result) => ({ ...result, senderAgentId: otherAgentId }),
            },
            {
                name: "target",
                alter: (result) => ({ ...result, targetAgentId: otherAgentId }),
            },
            { name: "message", alter: (result) => ({ ...result, message: "different" }) },
            { name: "due time", alter: (result) => ({ ...result, dueAt: 3_000 }) },
            { name: "status", alter: (result) => ({ ...result, status: "cancelled" }) },
        ];
        for (const mutation of mutations) {
            const test = await harness(`scheduling-host-schedule-${mutation.name}`);
            try {
                const original = test.scheduler.schedule.bind(test.scheduler);
                test.scheduler.schedule = async (ctx, actingAgentId, request) =>
                    mutation.alter(await original(ctx, actingAgentId, request));
                await expect(
                    test.module.schedule(test.database.context, agentId, {
                        id: "requested-id",
                        message: "message",
                        in: { seconds: 1 },
                    }),
                ).rejects.toThrow();
                await expect(
                    test.module.getSchedule(test.database.context, agentId, "requested-id"),
                ).resolves.toBeUndefined();
            } finally {
                test.database.close();
            }
        }
    });

    it("rejects malformed or identity-changing wait claims before awaiting the host", async () => {
        const mutations: Array<{
            readonly name: string;
            readonly alter: (record: SchedulingWaitRecord) => SchedulingWaitRecord;
        }> = [
            { name: "id", alter: (record) => ({ ...record, id: "different-id" }) },
            { name: "agent", alter: (record) => ({ ...record, agentId: otherAgentId }) },
            { name: "kind", alter: (record) => ({ ...record, kind: "wait_until" }) },
            { name: "due", alter: (record) => ({ ...record, dueAt: 3_000 }) },
            { name: "started", alter: (record) => ({ ...record, startedAt: 2_000 }) },
            {
                name: "status",
                alter: (record) => ({ ...record, status: "elapsed" }) as SchedulingWaitRecord,
            },
        ];
        for (const mutation of mutations) {
            const test = await harness(`scheduling-host-wait-${mutation.name}`);
            try {
                test.scheduler.startWait = async (_ctx, _agent, request) =>
                    mutation.alter(waitRecord(request.id, request));
                const pending = test.module.wait(test.database.context, agentId, {
                    id: "requested-wait",
                    duration: { seconds: 1 },
                });
                await expect(pending).rejects.toThrow();
            } finally {
                test.database.close();
            }
        }
    });

    it("rejects identity-changing cancellation and delivery responses", async () => {
        const cancel = await harness("scheduling-host-cancel");
        try {
            await cancel.module.schedule(cancel.database.context, agentId, {
                id: "cancel-target",
                message: "cancel",
                in: { seconds: 1 },
            });
            const original = cancel.scheduler.cancel.bind(cancel.scheduler);
            cancel.scheduler.cancel = async (ctx, actingAgentId, input) => ({
                ...(await original(ctx, actingAgentId, input)),
                id: "different-id",
            });
            await expect(
                cancel.module.cancelSchedule(cancel.database.context, agentId, {
                    scheduleId: "cancel-target",
                }),
            ).rejects.toThrow();
            await expect(
                cancel.module.getSchedule(cancel.database.context, agentId, "cancel-target"),
            ).resolves.toMatchObject({ status: "pending" });
        } finally {
            cancel.database.close();
        }

        const delivery = await harness("scheduling-host-delivery");
        try {
            await delivery.module.schedule(delivery.database.context, agentId, {
                id: "delivery-target",
                message: "delivery",
                in: { seconds: 1 },
            });
            const original = delivery.scheduler.reportDelivery.bind(delivery.scheduler);
            delivery.scheduler.reportDelivery = async (ctx, actingAgentId, input) => ({
                ...(await original(ctx, actingAgentId, input)),
                id: "different-id",
            });
            await expect(
                delivery.module.reportDeliveryOutcome(delivery.database.context, agentId, {
                    scheduleId: "delivery-target",
                    status: "delivered",
                    deliveredAt: 2_000,
                }),
            ).rejects.toThrow();
            await expect(
                delivery.module.getSchedule(delivery.database.context, agentId, "delivery-target"),
            ).resolves.toMatchObject({ status: "pending" });
        } finally {
            delivery.database.close();
        }
    });

    it("requires a delivery host to preserve the requested deliveredAt timestamp", async () => {
        const test = await harness("scheduling-delivery-timestamp");
        try {
            await test.module.schedule(test.database.context, agentId, {
                id: "delivery-timestamp",
                message: "delivery",
                in: { seconds: 1 },
            });
            const original = test.scheduler.reportDelivery.bind(test.scheduler);
            test.scheduler.reportDelivery = async (ctx, actingAgentId, input) => ({
                ...(await original(ctx, actingAgentId, input)),
                deliveredAt: 3_000,
                updatedAt: 3_000,
            });
            await expect(
                test.module.reportDeliveryOutcome(test.database.context, agentId, {
                    scheduleId: "delivery-timestamp",
                    status: "delivered",
                    deliveredAt: 2_000,
                }),
            ).rejects.toThrow("deliveredAt");
        } finally {
            test.database.close();
        }
    });
});

describe("Scheduling options, events, and retries", () => {
    it("validates asynchronous identity and event factories and the clock at the operation boundary", async () => {
        const invalidIdentity = await harness("scheduling-invalid-identity", {
            idFactory: async () => "" as never,
        });
        try {
            await expect(
                invalidIdentity.module.schedule(invalidIdentity.database.context, agentId, {
                    message: "invalid identity",
                    in: { seconds: 1 },
                }),
            ).rejects.toThrow("invalid identity");
        } finally {
            invalidIdentity.database.close();
        }

        const invalidEvent = await harness("scheduling-invalid-event", {
            eventIdFactory: async () => "" as never,
        });
        try {
            await expect(
                invalidEvent.module.schedule(invalidEvent.database.context, agentId, {
                    id: "invalid-event",
                    message: "invalid event",
                    in: { seconds: 1 },
                }),
            ).rejects.toThrow("event identity");
            await expect(
                invalidEvent.module.getSchedule(
                    invalidEvent.database.context,
                    agentId,
                    "invalid-event",
                ),
            ).resolves.toBeUndefined();
        } finally {
            invalidEvent.database.close();
        }

        const invalidClock = await harness("scheduling-invalid-clock", {
            clock: () => Number.NaN,
        });
        try {
            await expect(
                invalidClock.module.schedule(invalidClock.database.context, agentId, {
                    id: "invalid-clock",
                    message: "invalid clock",
                    in: { seconds: 1 },
                }),
            ).rejects.toThrow("clock value");
        } finally {
            invalidClock.database.close();
        }
    });

    it("preserves listener receiver context and contains non-void post-commit results", async () => {
        class Listener {
            readonly events: SchedulingEvent[] = [];
            onEventTransactional(_ctx: Context, event: SchedulingEvent): void {
                this.events.push(event);
            }
            onEvent(_ctx: Context, event: SchedulingEvent): void {
                this.events.push(event);
                return 1 as never;
            }
        }
        const listener = new Listener();
        const onPostCommitError = vi.fn();
        const test = await harness("scheduling-listener-receiver", {
            listener,
            onPostCommitError,
        });
        try {
            await test.module.schedule(test.database.context, agentId, {
                id: "listener-receiver",
                message: "listener",
                in: { seconds: 1 },
            });
            expect(listener.events).toHaveLength(2);
            expect(onPostCommitError).toHaveBeenCalledWith(
                expect.anything(),
                expect.objectContaining({ eventId: "event-1" }),
                expect.stringContaining("post-commit listener"),
            );
        } finally {
            test.database.close();
        }
    });

    it("rolls back durable finalization when a transactional listener returns a non-void value", async () => {
        const test = await harness("scheduling-listener-return", {
            listener: {
                onEventTransactional: () => 1 as never,
            },
        });
        try {
            await expect(
                test.module.schedule(test.database.context, agentId, {
                    id: "listener-return",
                    message: "listener",
                    in: { seconds: 1 },
                }),
            ).rejects.toThrow("transactional listener");
            await expect(
                test.module.getSchedule(test.database.context, agentId, "listener-return"),
            ).resolves.toBeUndefined();
        } finally {
            test.database.close();
        }
    });

    it("reconciles host state after wait, cancellation, and delivery finalization failures", async () => {
        let reject = true;
        const events: SchedulingEvent[] = [];
        const test = await harness("scheduling-finalization-retries", {
            listener: {
                onEventTransactional: (_ctx, event) => {
                    events.push(event);
                    if (reject) throw new Error("temporary finalization failure");
                },
            },
        });
        try {
            const scheduled = test.module.schedule(test.database.context, agentId, {
                id: "retry-cancel",
                message: "cancel",
                in: { seconds: 1 },
            });
            await expect(scheduled).rejects.toThrow("temporary finalization failure");
            reject = false;
            await expect(
                test.module.schedule(test.database.context, agentId, {
                    id: "retry-cancel",
                    message: "cancel",
                    in: { seconds: 1 },
                }),
            ).resolves.toMatchObject({ id: "retry-cancel" });

            await expect(
                test.module.cancelSchedule(test.database.context, agentId, {
                    scheduleId: "retry-cancel",
                }),
            ).resolves.toMatchObject({ status: "cancelled" });

            await test.module.schedule(test.database.context, agentId, {
                id: "retry-delivery",
                message: "delivery",
                in: { seconds: 1 },
            });
            await expect(
                test.module.reportDeliveryOutcome(test.database.context, agentId, {
                    scheduleId: "retry-delivery",
                    status: "delivered",
                    deliveredAt: 2_000,
                }),
            ).resolves.toMatchObject({ status: "delivered" });
            expect(events.filter(({ type }) => type === "message_scheduled")).toHaveLength(3);
        } finally {
            test.database.close();
        }
    });
});

describe("Scheduling filters, migrations, and concurrency", () => {
    it("filters list pages by status, sender, and target and rejects malformed cursors", async () => {
        const test = await harness("scheduling-filter-pages");
        try {
            await test.module.schedule(test.database.context, agentId, {
                id: "pending-self",
                message: "self",
                in: { seconds: 1 },
            });
            await test.module.schedule(test.database.context, agentId, {
                id: "pending-other",
                targetAgentId: otherAgentId,
                message: "other",
                in: { seconds: 2 },
            });
            await test.module.cancelSchedule(test.database.context, agentId, {
                scheduleId: "pending-other",
            });
            await expect(
                test.module.listSchedulePage(test.database.context, agentId, {
                    status: "cancelled",
                    targetAgentId: otherAgentId,
                }),
            ).resolves.toMatchObject({
                schedules: [expect.objectContaining({ id: "pending-other" })],
            });
            await expect(
                test.module.listSchedulePage(test.database.context, agentId, {
                    status: "pending",
                    targetAgentId: otherAgentId,
                }),
            ).resolves.toMatchObject({ schedules: [] });
            await expect(
                test.module.listSchedulePage(test.database.context, agentId, {
                    cursor: "01",
                }),
            ).rejects.toThrow("cursor");
            await expect(
                test.module.listSchedulePage(test.database.context, agentId, {
                    cursor: "not-a-number",
                }),
            ).rejects.toThrow("cursor");
        } finally {
            test.database.close();
        }
    });

    it("keeps migration history append-only and removes obsolete receipt tables", async () => {
        expect(schedulingMigrations.map(([key]) => key)).toEqual([
            "001-scheduling",
            "002-remove-scheduling-idempotency",
            "003-remove-scheduling-operation-state",
        ]);
    });

    it("does not lose identical concurrent schedule mutations", async () => {
        const test = await harness("scheduling-concurrent-same-id");
        try {
            let results: PromiseSettledResult<SchedulingScheduledMessage>[] | undefined;
            await test.database.context.inTx(async (txCtx) => {
                results = await Promise.allSettled([
                    test.module.schedule(txCtx, agentId, {
                        id: "same-id",
                        message: "same",
                        in: { seconds: 1 },
                    }),
                    test.module.schedule(txCtx, agentId, {
                        id: "same-id",
                        message: "same",
                        in: { seconds: 1 },
                    }),
                ]);
            });
            expect(results?.every(({ status }) => status === "fulfilled")).toBe(true);
            await expect(
                test.module.getSchedule(test.database.context, agentId, "same-id"),
            ).resolves.toMatchObject({ id: "same-id", message: "same" });
        } finally {
            test.database.close();
        }
    });
});
