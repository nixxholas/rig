import { AgentKV, withAgentKV } from "@slopus/happy-agent-base";
import { createRootContext, type Context } from "@steve.kite/stdlib";
import { describe, expect, it } from "vitest";

import {
    SchedulingModule,
    assertSchedulingScheduledMessage,
    schedulingDurationSchema,
    schedulingMutationProofSchema,
    schedulingMutationReceiptSchema,
    schedulingSchedulePageSchema,
    schedulingScheduledMessageSchema,
    schedulingTransactionChangeSchema,
    type SchedulingEvent,
    type SchedulingMutationReceipt,
    type SchedulingScheduledMessage,
    type SchedulingWaitResult,
} from "../../sources/scheduling/index.js";
import { Value } from "@sinclair/typebox/value";
import {
    InMemorySchedulingScheduler,
    InMemorySchedulingStore,
} from "./support/InMemoryScheduling.js";

const root = createRootContext().named("scheduling-module-test");
const agentId = "agent-a";

function makeModule(
    store: InMemorySchedulingStore,
    scheduler: InMemorySchedulingScheduler,
    now: { value: number },
    events: SchedulingEvent[] = [],
): SchedulingModule {
    return new SchedulingModule({
        store,
        scheduler,
        clock: (_ctx: Context, _agentId: string) => now.value,
        idFactory: (() => {
            let counter = 0;
            return () => `s${++counter}`;
        })(),
        eventIdFactory: (() => {
            let counter = 0;
            return () => `e${++counter}`;
        })(),
        listener: {
            onEventTransactional: (_ctx, event) => {
                events.push(event);
            },
            onEvent: (_ctx, event) => {
                events.push(event);
            },
        },
    });
}

class ClassBackedSchedulingStore extends InMemorySchedulingStore {
    readonly #scheduler: InMemorySchedulingScheduler;

    constructor() {
        super();
        this.#scheduler = new InMemorySchedulingScheduler(this);
    }

    startWait(...args: Parameters<InMemorySchedulingScheduler["startWait"]>) {
        return this.#scheduler.startWait(...args);
    }

    wait(...args: Parameters<InMemorySchedulingScheduler["wait"]>) {
        return this.#scheduler.wait(...args);
    }

    schedule(...args: Parameters<InMemorySchedulingScheduler["schedule"]>) {
        return this.#scheduler.schedule(...args);
    }

    cancel(...args: Parameters<InMemorySchedulingScheduler["cancel"]>) {
        return this.#scheduler.cancel(...args);
    }

    reportDelivery(...args: Parameters<InMemorySchedulingScheduler["reportDelivery"]>) {
        return this.#scheduler.reportDelivery(...args);
    }
}

describe("SchedulingModule", () => {
    it("schedules and cancels through one shared public implementation", async () => {
        const store = new InMemorySchedulingStore();
        const scheduler = new InMemorySchedulingScheduler(store);
        const events: SchedulingEvent[] = [];
        const module = makeModule(store, scheduler, { value: 1_000 }, events);

        const scheduled = await module.schedule(root, agentId, {
            operationId: "schedule-op",
            id: "message-1",
            in: { unit: "minutes", value: 1 },
            message: "check back",
        });
        expect(scheduled.targetAgentId).toBe(agentId);
        await expect(
            module.cancelSchedule(root, agentId, {
                operationId: "cancel-op",
                scheduleId: scheduled.id,
            }),
        ).resolves.toMatchObject({ id: "message-1", status: "cancelled" });
        expect(scheduler.calls).toEqual(["schedule", "cancel"]);
        expect(events[0]).toBe(events[1]);
    });

    it("samples a relative schedule after store latency", async () => {
        const store = new InMemorySchedulingStore();
        const scheduler = new InMemorySchedulingScheduler(store);
        const now = { value: 1_000 };
        const originalReadSchedule = store.readSchedule.bind(store);
        let delayed = true;
        store.readSchedule = async (...args) => {
            if (delayed) {
                delayed = false;
                await Promise.resolve();
                now.value = 3_000;
            }
            return await originalReadSchedule(...args);
        };
        const originalSchedule = scheduler.schedule.bind(scheduler);
        scheduler.schedule = async (ctx, actingAgentId, request) => {
            const scheduled = await originalSchedule(ctx, actingAgentId, request);
            const truthful = {
                ...scheduled,
                createdAt: now.value,
                updatedAt: now.value,
            };
            await store.writeSchedule(ctx, truthful);
            return truthful;
        };
        const module = makeModule(store, scheduler, now);

        await expect(
            module.schedule(root, agentId, {
                operationId: "latency-schedule-op",
                id: "latency-schedule",
                in: { unit: "seconds", value: 1 },
                message: "short schedule",
            }),
        ).resolves.toMatchObject({
            dueAt: 4_000,
            createdAt: 3_000,
            status: "pending",
        });
    });

    it("binds class-backed scheduler methods when the optional scheduler is omitted", async () => {
        const store = new ClassBackedSchedulingStore();
        const module = new SchedulingModule({
            store,
            clock: () => 1_000,
        });
        await expect(
            module.schedule(root, agentId, {
                operationId: "fallback-schedule-op",
                id: "fallback-message",
                in: { unit: "seconds", value: 1 },
                message: "fallback",
            }),
        ).resolves.toMatchObject({ id: "fallback-message", status: "pending" });
    });

    it("reports an interruption using actual elapsed time and reattaches after restart", async () => {
        const store = new InMemorySchedulingStore();
        const scheduler = new InMemorySchedulingScheduler(store);
        const now = { value: 1_000 };
        const module = makeModule(store, scheduler, now);

        const promise = module.wait(root, agentId, {
            operationId: "wait-op",
            id: "wait-1",
            duration: { unit: "hours", value: 1 },
        });
        await scheduler.waitStarted;
        const restartedScheduler = new InMemorySchedulingScheduler(store);
        const restarted = makeModule(store, restartedScheduler, now);
        const restartedPromise = restarted.wait(root, agentId, {
            operationId: "wait-op",
            id: "wait-1",
            duration: { unit: "hours", value: 1 },
        });
        await restartedScheduler.waitStartedFor("wait-1");
        now.value = 4_000;
        restartedScheduler.settle("wait-1", {
            waitId: "wait-1",
            agentId,
            operationId: "wait-op",
            fingerprint: store.waits.get("wait-1")!.fingerprint,
            outcome: "interrupted",
            kind: "wait",
            dueAt: 3_601_000,
            startedAt: 1_000,
            endedAt: 4_000,
            elapsedMs: 3_000,
        });
        const [result] = await Promise.all([promise, restartedPromise]);
        expect(result).toMatchObject({ outcome: "interrupted", elapsedMs: 3_000 });
        expect(module.formatWaitForModel(result)).toContain("3 seconds");
        expect(restartedScheduler.calls.filter((call) => call === "wait")).toHaveLength(1);
        expect(scheduler.calls.filter((call) => call === "wait")).toHaveLength(1);
    });

    it("enforces time bounds and keeps page output actionable", async () => {
        const store = new InMemorySchedulingStore();
        const scheduler = new InMemorySchedulingScheduler(store);
        const module = new SchedulingModule({
            store,
            scheduler,
            clock: () => 1_000,
            maxWaitDuration: 60_000,
            maxScheduleHorizon: 60_000,
            maxOutputCharacters: 256,
        });
        await expect(
            module.wait(root, agentId, {
                operationId: "too-long",
                duration: { unit: "hours", value: 1 },
            }),
        ).rejects.toThrow("cannot exceed");
        await expect(
            module.waitUntil(root, agentId, {
                operationId: "past",
                at: "1970-01-01T00:00:00Z",
            }),
        ).rejects.toThrow("past");

        store.schedules.set("a".repeat(128), {
            id: "a".repeat(128),
            senderAgentId: agentId,
            targetAgentId: agentId,
            message: "hello",
            dueAt: 10_000,
            status: "pending",
            operationId: "stored-operation",
            fingerprint: "{}",
            createdAt: 1_000,
            updatedAt: 1_000,
        });
        const page = await module.listSchedulePage(root, agentId, { limit: 1 });
        expect(schedulingSchedulePageSchema).toBeDefined();
        expect(module.formatSchedulePageForModel(page)).toContain("a".repeat(128));
    });

    it("omits schedule_message when the injected policy forbids it", async () => {
        const store = new InMemorySchedulingStore();
        const scheduler = new InMemorySchedulingScheduler(store);
        const module = new SchedulingModule({
            store,
            scheduler,
            scheduleMessagePolicy: () => false,
        });
        const scope = {
            agent: {
                id: agentId,
            },
        } as never;
        const tools = await module.tools(root, scope);
        expect(tools.map((tool) => tool.name)).toEqual([
            "wait",
            "wait_until",
            "cancel_scheduled_message",
            "list_scheduled_messages",
        ]);
        await expect(
            module.schedule(root, agentId, {
                operationId: "forbidden",
                id: "forbidden-message",
                in: { unit: "seconds", value: 1 },
                message: "no",
            }),
        ).rejects.toThrow("not allowed");
    });

    it("accepts every duration unit and rejects malformed or out-of-range timing", async () => {
        expect(
            Value.Check(schedulingDurationSchema, { unit: "seconds", value: 1 }),
        ).toBe(true);
        expect(
            Value.Check(schedulingDurationSchema, { unit: "minutes", value: 1 }),
        ).toBe(true);
        expect(Value.Check(schedulingDurationSchema, { unit: "hours", value: 1 })).toBe(true);
        expect(Value.Check(schedulingDurationSchema, { unit: "days", value: 1 })).toBe(true);
        expect(Value.Check(schedulingDurationSchema, { seconds: 1 })).toBe(true);
        expect(Value.Check(schedulingDurationSchema, { minutes: 1 })).toBe(true);
        expect(Value.Check(schedulingDurationSchema, { hours: 1 })).toBe(true);
        expect(Value.Check(schedulingDurationSchema, { days: 1 })).toBe(true);

        const store = new InMemorySchedulingStore();
        const scheduler = new InMemorySchedulingScheduler(store);
        const now = { value: 1_000 };
        const module = makeModule(store, scheduler, now);
        const durations = [
            { unit: "seconds" as const, value: 1 },
            { unit: "minutes" as const, value: 1 },
            { unit: "hours" as const, value: 1 },
            { unit: "days" as const, value: 0.01 },
        ];
        for (const [index, duration] of durations.entries()) {
            const operationId = `duration-op-${index}`;
            const waitId = `duration-wait-${index}`;
            const pending = module.wait(root, agentId, {
                operationId,
                id: waitId,
                duration,
            });
            await scheduler.waitStartedFor(waitId);
            const startedAt = now.value;
            const elapsed = startedAt + 1;
            now.value = elapsed;
            scheduler.settle(waitId, {
                waitId,
                agentId,
                operationId,
                fingerprint: store.waits.get(waitId)!.fingerprint,
                outcome: "interrupted",
                kind: "wait",
                dueAt: store.waits.get(waitId)!.dueAt,
                startedAt,
                endedAt: elapsed,
                elapsedMs: 1,
            });
            await expect(pending).resolves.toMatchObject({
                waitId,
                elapsedMs: 1,
            });
        }

        await expect(
            module.wait(root, agentId, {
                operationId: "negative",
                duration: { unit: "seconds", value: -1 },
            } as never),
        ).rejects.toThrow("invalid");
        await expect(
            module.waitUntil(root, agentId, {
                operationId: "malformed-date",
                at: "not-an-instant",
            } as never),
        ).rejects.toThrow("invalid");
        await expect(
            module.waitUntil(root, agentId, {
                operationId: "too-far",
                at: "2099-01-01T00:00:00Z",
            }),
        ).rejects.toThrow("more than");
    });

    it("derives elapsed time from the durable start and injected clock", async () => {
        const store = new InMemorySchedulingStore();
        const scheduler = new InMemorySchedulingScheduler(store);
        const now = { value: 1_000 };
        const module = makeModule(store, scheduler, now);
        const pending = module.wait(root, agentId, {
            operationId: "clock-op",
            id: "clock-wait",
            duration: { unit: "seconds", value: 10 },
        });
        await scheduler.waitStartedFor("clock-wait");
        now.value = 4_000;
        scheduler.settle("clock-wait", {
            waitId: "clock-wait",
            agentId,
            operationId: "clock-op",
            fingerprint: store.waits.get("clock-wait")!.fingerprint,
            outcome: "interrupted",
            kind: "wait",
            dueAt: store.waits.get("clock-wait")!.dueAt,
            startedAt: 1_000,
            endedAt: 5_000,
            elapsedMs: 4_000,
        });
        await expect(pending).rejects.toThrow("scheduling clock");
        expect(store.waits.get("clock-wait")?.status).toBe("waiting");
    });

    it("rejects a scheduler that substitutes the durable wait start", async () => {
        const store = new InMemorySchedulingStore();
        const scheduler = new InMemorySchedulingScheduler(store);
        const originalStartWait = scheduler.startWait.bind(scheduler);
        scheduler.startWait = async (ctx, actingAgentId, request) => {
            const wait = await originalStartWait(ctx, actingAgentId, request);
            return {
                ...wait,
                createdAt: 0,
                updatedAt: 0,
                startedAt: 0,
            };
        };
        const module = makeModule(store, scheduler, { value: 1_000 });

        await expect(
            module.wait(root, agentId, {
                operationId: "forged-start-op",
                id: "forged-start-wait",
                duration: { unit: "seconds", value: 1 },
            }),
        ).rejects.toThrow("durable wait does not match");
        expect(store.waits.has("forged-start-wait")).toBe(false);
    });

    it("derives settlement elapsed time after bounded clock hand-off progress", async () => {
        const store = new InMemorySchedulingStore();
        const scheduler = new InMemorySchedulingScheduler(store);
        const now = { value: 1_000 };
        const module = makeModule(store, scheduler, now);
        const pending = module.wait(root, agentId, {
            operationId: "settlement-drift-op",
            id: "settlement-drift-wait",
            duration: { unit: "seconds", value: 10 },
        });
        await scheduler.waitStartedFor("settlement-drift-wait");
        now.value = 1_500;
        scheduler.settle("settlement-drift-wait", {
            waitId: "settlement-drift-wait",
            agentId,
            operationId: "settlement-drift-op",
            fingerprint: store.waits.get("settlement-drift-wait")!.fingerprint,
            outcome: "interrupted",
            kind: "wait",
            dueAt: store.waits.get("settlement-drift-wait")!.dueAt,
            startedAt: 1_000,
            endedAt: 1_200,
            elapsedMs: 200,
        });

        await expect(pending).resolves.toMatchObject({
            outcome: "interrupted",
            elapsedMs: 500,
        });
    });

    it("derives a relative due time from the durable claim instant", async () => {
        const store = new InMemorySchedulingStore();
        const scheduler = new InMemorySchedulingScheduler(store);
        const now = { value: 1_000 };
        const originalReadWait = store.readWait.bind(store);
        let delayed = true;
        store.readWait = async (...args) => {
            if (delayed) {
                delayed = false;
                await Promise.resolve();
                now.value = 3_000;
            }
            return await originalReadWait(...args);
        };
        const module = makeModule(store, scheduler, now);
        const pending = module.wait(root, agentId, {
            operationId: "claim-instant-op",
            id: "claim-instant-wait",
            duration: { unit: "seconds", value: 1 },
        });
        await scheduler.waitStartedFor("claim-instant-wait");
        expect(store.waits.get("claim-instant-wait")?.startedAt).toBe(3_000);
        expect(store.waits.get("claim-instant-wait")?.dueAt).toBe(4_000);
        now.value = 3_001;
        scheduler.settle("claim-instant-wait", {
            waitId: "claim-instant-wait",
            agentId,
            operationId: "claim-instant-op",
            fingerprint: store.waits.get("claim-instant-wait")!.fingerprint,
            outcome: "interrupted",
            kind: "wait",
            dueAt: 4_000,
            startedAt: 3_000,
            endedAt: 3_001,
            elapsedMs: 1,
        });
        await expect(pending).resolves.toMatchObject({ elapsedMs: 1 });
    });

    it("rejects sub-millisecond durations and host mutations without operation identities", async () => {
        const store = new InMemorySchedulingStore();
        const scheduler = new InMemorySchedulingScheduler(store);
        const module = makeModule(store, scheduler, { value: 1_000 });
        await expect(
            module.wait(root, agentId, {
                operationId: "fractional-op",
                id: "fractional-wait",
                duration: { unit: "seconds", value: 0.0001 },
            }),
        ).rejects.toThrow("whole number of milliseconds");
        await expect(
            module.schedule(root, agentId, {
                id: "host-message",
                in: { unit: "seconds", value: 1 },
                message: "missing operation",
            }),
        ).rejects.toThrow("operation identity");
    });

    it("rejects incompatible delivery outcomes and substituted terminal records", async () => {
        const store = new InMemorySchedulingStore();
        const scheduler = new InMemorySchedulingScheduler(store);
        const module = makeModule(store, scheduler, { value: 1_000 });
        const scheduled = await module.schedule(root, agentId, {
            operationId: "substitution-schedule",
            id: "substitution-message",
            in: { unit: "seconds", value: 1 },
            message: "substitute me",
        });
        await expect(
            module.reportDeliveryOutcome(root, agentId, {
                operationId: "invalid-delivery",
                scheduleId: scheduled.id,
                status: "delivered",
                failure: "incompatible",
            } as never),
        ).rejects.toThrow("invalid");
        const originalCancel = scheduler.cancel.bind(scheduler);
        scheduler.cancel = async (ctx, actingAgentId, input) => ({
            ...(await originalCancel(ctx, actingAgentId, input)),
            targetAgentId: "agent-b",
        });
        await expect(
            module.cancelSchedule(root, agentId, {
                operationId: "substitution-cancel",
                scheduleId: scheduled.id,
            }),
        ).rejects.toThrow("requested identity");
    });

    it("rejects malformed durable state at the store boundary", async () => {
        const store = new InMemorySchedulingStore();
        const scheduler = new InMemorySchedulingScheduler(store);
        const now = { value: 1_000 };
        const module = makeModule(store, scheduler, now);
        store.waits.set("bad-wait", {
            id: "bad-wait",
            agentId,
            operationId: "bad-operation",
            fingerprint: "{}",
            kind: "wait",
            dueAt: 1_000,
            createdAt: 1_000,
            updatedAt: 1_000,
            startedAt: 1_000,
            status: "elapsed",
            finishedAt: 999,
            elapsedMs: 0,
        });
        await expect(
            module.wait(root, agentId, {
                operationId: "bad-operation",
                id: "bad-wait",
                duration: { unit: "seconds", value: 0 },
            }),
        ).rejects.toThrow("untruthful");

        store.schedules.set("bad-message", {
            id: "bad-message",
            senderAgentId: agentId,
            targetAgentId: agentId,
            message: "bad",
            dueAt: 999,
            status: "pending",
            operationId: "bad-operation",
            fingerprint: "{}",
            createdAt: 1_000,
            updatedAt: 1_000,
        });
        await expect(module.getSchedule(root, agentId, "bad-message")).rejects.toThrow(
            "before it was created",
        );
    });

    it("replays schedule and cancel receipts without duplicate mutations or events", async () => {
        const store = new InMemorySchedulingStore();
        const scheduler = new InMemorySchedulingScheduler(store);
        const events: SchedulingEvent[] = [];
        const module = makeModule(store, scheduler, { value: 1_000 }, events);
        const request = {
            operationId: "schedule-replay-op",
            id: "replay-message",
            in: { unit: "seconds" as const, value: 2 },
            message: "replay me",
        };
        const first = await module.schedule(root, agentId, request);
        const callCount = scheduler.calls.length;
        await expect(module.schedule(root, agentId, request)).resolves.toEqual(first);
        expect(scheduler.calls).toHaveLength(callCount);

        const cancelled = await module.cancelSchedule(root, agentId, {
            operationId: "cancel-replay-op",
            scheduleId: first.id,
        });
        expect(cancelled.status).toBe("cancelled");
        const opposite: SchedulingScheduledMessage = {
            ...cancelled,
            status: "delivered",
            deliveredAt: cancelled.updatedAt + 1,
            updatedAt: cancelled.updatedAt + 1,
        };
        await store.writeSchedule(root, opposite);
        const cancelCalls = scheduler.calls.filter((call) => call === "cancel").length;
        await expect(
            module.cancelSchedule(root, agentId, {
                operationId: "cancel-replay-op",
                scheduleId: first.id,
            }),
        ).resolves.toMatchObject({ status: "cancelled" });
        expect(scheduler.calls.filter((call) => call === "cancel")).toHaveLength(cancelCalls);
        expect(events.filter((event) => event.type === "scheduled_message_cancelled")).toHaveLength(
            2,
        );
    });

    it("serializes a cancellation versus delivery race through the injected transaction", async () => {
        const store = new InMemorySchedulingStore();
        const scheduler = new InMemorySchedulingScheduler(store);
        const events: SchedulingEvent[] = [];
        const module = makeModule(store, scheduler, { value: 1_000 }, events);
        const scheduled = await module.schedule(root, agentId, {
            operationId: "race-schedule-op",
            id: "race-message",
            in: { unit: "seconds", value: 2 },
            message: "race",
        });

        const [cancelled, delivered] = await Promise.all([
            module.cancelSchedule(root, agentId, {
                operationId: "race-cancel-op",
                scheduleId: scheduled.id,
            }),
            module.reportDeliveryOutcome(root, agentId, {
                operationId: "race-delivery-op",
                scheduleId: scheduled.id,
                status: "delivered",
            }),
        ]);
        const final = await module.getSchedule(root, agentId, scheduled.id);
        expect(final?.status === "cancelled" || final?.status === "delivered").toBe(true);
        expect(
            [cancelled.status, delivered.status].filter(
                (status) => status === "cancelled" || status === "delivered",
            ),
        ).toHaveLength(2);
        expect(
            scheduler.calls.filter((call) => call === "cancel" || call === "delivery"),
        ).toHaveLength(1);
        expect(
            events.filter(
                (event) =>
                    event.type === "scheduled_message_cancelled" ||
                    event.type === "scheduled_message_delivery_outcome",
            ),
        ).toHaveLength(2);
        expect(store.transactionCount).toBe(3);
    });

    it("does not treat concurrent top-level transactions as nested", async () => {
        const store = new InMemorySchedulingStore();
        let releaseFirst!: () => void;
        let firstEntered!: () => void;
        const firstStarted = new Promise<void>((resolve) => {
            firstEntered = resolve;
        });
        const firstRelease = new Promise<void>((resolve) => {
            releaseFirst = resolve;
        });
        const change = {} as never;
        const first = store.transaction(root, agentId, async (txCtx) => {
            expect(txCtx).not.toBe(root);
            expect(store.depth).toBe(1);
            firstEntered();
            await firstRelease;
            return change;
        });
        await firstStarted;
        let secondEntered = false;
        const second = store.transaction(root, agentId, async () => {
            secondEntered = true;
            return change;
        });
        await Promise.resolve();
        expect(secondEntered).toBe(false);
        expect(store.transactionCount).toBe(1);
        releaseFirst();
        await Promise.all([first, second]);
        expect(secondEntered).toBe(true);
        expect(store.transactionCount).toBe(2);
        expect(store.depth).toBe(0);
    });

    it("recognizes a nested transaction through its transaction context", async () => {
        const store = new InMemorySchedulingStore();
        const change = {} as never;
        await store.transaction(root, agentId, async (txCtx) => {
            expect(store.depth).toBe(1);
            await store.transaction(txCtx, agentId, async (nestedCtx) => {
                expect(nestedCtx).toBe(txCtx);
                expect(store.depth).toBe(2);
                return change;
            });
            expect(store.depth).toBe(1);
            return change;
        });
        expect(store.transactionCount).toBe(1);
        expect(store.depth).toBe(0);
    });

    it("runs post-commit callbacks after release without rolling back publication", async () => {
        const store = new InMemorySchedulingStore();
        const change = {} as never;
        await expect(
            store.transaction(root, agentId, async (txCtx) => {
                store.schedules.set("published", {} as never);
                store.afterCommit(txCtx, async () => {
                    expect(store.depth).toBe(0);
                    throw new Error("post-commit failure");
                });
                return change;
            }),
        ).rejects.toThrow("post-commit failure");
        expect(store.schedules.has("published")).toBe(true);
        expect(store.depth).toBe(0);
    });

    it("discriminates durable mutation kind and result schemas", async () => {
        const scheduled: SchedulingScheduledMessage = {
            id: "schema-message",
            senderAgentId: agentId,
            targetAgentId: agentId,
            message: "schema",
            operationId: "schema-operation",
            fingerprint: "{}",
            dueAt: 2_000,
            status: "pending",
            createdAt: 1_000,
            updatedAt: 1_000,
        };
        const common = {
            operationId: "schema-operation",
            actingAgentId: agentId,
            fingerprint: "{}",
        };
        expect(
            Value.Check(schedulingMutationReceiptSchema, {
                ...common,
                kind: "wait",
                result: scheduled,
            }),
        ).toBe(false);
        expect(
            Value.Check(schedulingTransactionChangeSchema, {
                ...common,
                kind: "wait",
                result: scheduled,
                changed: false,
                events: [],
            }),
        ).toBe(false);
        expect(
            Value.Check(schedulingMutationProofSchema, {
                ...common,
                kind: "wait",
                subjectId: scheduled.id,
                before: null,
                after: scheduled,
                changed: false,
                result: scheduled,
            }),
        ).toBe(false);
    });

    it("requires a distinct delivery authorization and validates retained page cursors", async () => {
        const store = new InMemorySchedulingStore();
        const scheduler = new InMemorySchedulingScheduler(store);
        const module = new SchedulingModule({
            store,
            scheduler,
            clock: () => 1_000,
            authorization: {
                authorize: async (_ctx, _acting, _target, action) => action === "cancel",
            },
        });
        const ownedByOther = await module.schedule(root, "agent-b", {
            operationId: "other-schedule-op",
            id: "other-message",
            in: { unit: "seconds", value: 1 },
            message: "other",
        });
        await expect(
            module.reportDeliveryOutcome(root, agentId, {
                operationId: "other-delivery-op",
                scheduleId: ownedByOther.id,
                status: "delivered",
            }),
        ).rejects.toThrow("delivery");

        const emptyPage = await module.listSchedulePage(root, agentId, {
            limit: 1,
            cursor: "4",
        });
        expect(module.formatSchedulePageForModel(emptyPage)).toContain(
            "Earlier scheduled messages start at cursor 3.",
        );
    });

    it("rejects an empty page beyond the beginning without a previous cursor", async () => {
        const store = new InMemorySchedulingStore();
        const scheduler = new InMemorySchedulingScheduler(store);
        store.listSchedules = async () => ({ schedules: [], limit: 1 });
        const module = makeModule(store, scheduler, { value: 1_000 });
        await expect(
            module.listSchedulePage(root, agentId, { limit: 1, cursor: "1" }),
        ).rejects.toThrow("previous cursor");
    });

    it("enforces the configured schedule horizon when reading durable rows", async () => {
        const store = new InMemorySchedulingStore();
        const scheduler = new InMemorySchedulingScheduler(store);
        const module = new SchedulingModule({
            store,
            scheduler,
            clock: () => 1_000,
            maxScheduleHorizon: 1_000,
        });
        const schedule: SchedulingScheduledMessage = {
            id: "beyond-horizon",
            senderAgentId: agentId,
            targetAgentId: agentId,
            message: "too far",
            operationId: "beyond-horizon-op",
            fingerprint: "{}",
            dueAt: 3_000,
            status: "pending",
            createdAt: 1_000,
            updatedAt: 1_000,
        };
        store.schedules.set(schedule.id, schedule);
        await expect(module.getSchedule(root, agentId, schedule.id)).rejects.toThrow(
            "configured horizon",
        );
        await expect(
            module.listSchedulePage(root, agentId, { limit: 1 }),
        ).rejects.toThrow("configured horizon");
    });

    it("rejects delivery records and transitions recorded before due time", () => {
        const common = {
            id: "early-delivery",
            senderAgentId: agentId,
            targetAgentId: agentId,
            message: "early",
            operationId: "early-delivery-op",
            fingerprint: "{}",
            dueAt: 2_000,
            createdAt: 1_000,
        };
        expect(() =>
            assertSchedulingScheduledMessage({
                ...common,
                status: "delivered",
                deliveredAt: 1_999,
                updatedAt: 2_000,
            }),
        ).toThrow("delivery timestamp");
        expect(() =>
            assertSchedulingScheduledMessage({
                ...common,
                status: "undelivered",
                failure: "too early",
                updatedAt: 1_999,
            }),
        ).toThrow("before its due time");
    });

    it("uses singular units in model-facing durations", () => {
        const store = new InMemorySchedulingStore();
        const module = makeModule(store, new InMemorySchedulingScheduler(store), { value: 1_000 });
        const result: SchedulingWaitResult = {
            waitId: "duration-text-wait",
            agentId,
            operationId: "duration-text-op",
            fingerprint: "{}",
            outcome: "interrupted",
            kind: "wait",
            dueAt: 0,
            startedAt: 0,
            endedAt: 1,
            elapsedMs: 1,
        };
        expect(module.formatWaitForModel(result)).toContain("1 millisecond");
        expect(
            module.formatWaitForModel({ ...result, endedAt: 1_000, elapsedMs: 1_000 }),
        ).toContain("1 second");
        expect(
            module.formatWaitForModel({ ...result, endedAt: 1_001, elapsedMs: 1_001 }),
        ).toContain("1 second");
    });

    it("keeps delivery and cancellation outcomes transactional and reports listener failures", async () => {
        const store = new InMemorySchedulingStore();
        const scheduler = new InMemorySchedulingScheduler(store);
        const events: SchedulingEvent[] = [];
        const errors: string[] = [];
        const module = new SchedulingModule({
            store,
            scheduler,
            clock: () => 1_000,
            listener: {
                onEventTransactional: (_ctx, event) => {
                    events.push(event);
                },
                onEvent: () => {
                    throw new Error("observer failed");
                },
            },
            onPostCommitError: (_ctx, _event, error) => {
                errors.push(String(error));
            },
        });
        const scheduled = await module.schedule(root, agentId, {
            operationId: "delivery-schedule-op",
            id: "delivery-message",
            in: { unit: "seconds", value: 2 },
            message: "deliver me",
        });
        const delivered = await module.reportDeliveryOutcome(root, agentId, {
            operationId: "delivery-op",
            scheduleId: scheduled.id,
            status: "delivered",
        });
        expect(delivered.status).toBe("delivered");
        expect(events.filter((event) => event.type === "scheduled_message_delivery_outcome")).toHaveLength(
            1,
        );
        expect(errors).toContain("observer failed");
    });

    it("denies cross-agent scheduling by default and permits it through authorization", async () => {
        const store = new InMemorySchedulingStore();
        const scheduler = new InMemorySchedulingScheduler(store);
        const denied = makeModule(store, scheduler, { value: 1_000 });
        await expect(
            denied.schedule(root, agentId, {
                operationId: "cross-denied",
                id: "cross-message",
                targetAgentId: "agent-b",
                in: { unit: "seconds", value: 1 },
                message: "cross",
            }),
        ).rejects.toThrow("not authorized");

        const allowed = new SchedulingModule({
            store,
            scheduler,
            clock: () => 1_000,
            authorization: {
                authorize: async (_ctx, acting, target, action) =>
                    acting === agentId && target === "agent-b" && action === "schedule",
            },
        });
        await expect(
            allowed.schedule(root, agentId, {
                operationId: "cross-allowed",
                id: "cross-message",
                targetAgentId: "agent-b",
                in: { unit: "seconds", value: 1 },
                message: "cross",
            }),
        ).resolves.toMatchObject({ targetAgentId: "agent-b" });
    });

    it("does not publish a post-commit event when the outer mutation rolls back", async () => {
        const store = new InMemorySchedulingStore();
        const scheduler = new InMemorySchedulingScheduler(store);
        const postEvents: SchedulingEvent[] = [];
        const module = new SchedulingModule({
            store,
            scheduler,
            clock: () => 1_000,
            listener: {
                onEvent: (_ctx, event) => {
                    postEvents.push(event);
                },
            },
        });
        const originalWriteReceipt = store.writeReceipt.bind(store);
        store.writeReceipt = async (
            ctx: Context,
            receipt: SchedulingMutationReceipt,
        ) => {
            await originalWriteReceipt(ctx, receipt);
            throw new Error("forced rollback");
        };
        await expect(
            module.schedule(root, agentId, {
                operationId: "rollback-op",
                id: "rollback-message",
                in: { unit: "seconds", value: 1 },
                message: "rollback",
            }),
        ).rejects.toThrow("forced rollback");
        expect(postEvents).toHaveLength(0);
        expect(store.schedules.size).toBe(0);
    });

    it("keeps every returned schedule identity complete at the minimum output budget", async () => {
        const store = new InMemorySchedulingStore();
        const scheduler = new InMemorySchedulingScheduler(store);
        const module = new SchedulingModule({
            store,
            scheduler,
            clock: () => 1_000,
            maxOutputCharacters: 256,
        });
        const id = "z".repeat(128);
        const schedule: SchedulingScheduledMessage = {
            id,
            senderAgentId: agentId,
            targetAgentId: agentId,
            message: "complete identity",
            dueAt: 2_000,
            status: "pending",
            operationId: "manual-operation",
            fingerprint: "{}",
            createdAt: 1_000,
            updatedAt: 1_000,
        };
        expect(schedulingScheduledMessageSchema).toBeDefined();
        await store.writeSchedule(root, schedule);
        const page = await module.listSchedulePage(root, agentId, { limit: 1 });
        expect(module.formatSchedulePageForModel(page)).toContain(id);
    });

    it("fits a maximum-length middle-page identity at the minimum budget", async () => {
        const store = new InMemorySchedulingStore();
        const scheduler = new InMemorySchedulingScheduler(store);
        const module = new SchedulingModule({
            store,
            scheduler,
            clock: () => 1_000,
            maxOutputCharacters: 256,
        });
        for (const [index, prefix] of ["a", "m", "z"].entries()) {
            const id = prefix.repeat(128);
            store.schedules.set(id, {
                id,
                senderAgentId: agentId,
                targetAgentId: agentId,
                message: `message-${index}`,
                operationId: `middle-page-op-${index}`,
                fingerprint: "{}",
                dueAt: 2_000,
                status: "pending",
                createdAt: 1_000,
                updatedAt: 1_000,
            });
        }

        const page = await module.listSchedulePage(root, agentId, {
            limit: 1,
            cursor: "1",
        });
        const text = module.formatSchedulePageForModel(page);
        expect(text).toContain("m".repeat(128));
        expect(text).toContain("Earlier cursor 0.");
        expect(text).toContain("More cursor 2.");
        expect(text.length).toBeLessThanOrEqual(256);
    });

    it("reattaches a durable tool identity from call-scoped AgentKV", async () => {
        const store = new InMemorySchedulingStore();
        const scheduler = new InMemorySchedulingScheduler(store);
        const now = { value: 1_000 };
        const module = makeModule(store, scheduler, now);
        const values = new Map<string, unknown>();
        const callKV = new AgentKV(
            {
                readValues: async (_ctx: Context, prefix: string) => {
                    const value = values.get(prefix);
                    return value === undefined ? [] : [{ key: prefix, value }];
                },
                writeValue: async (_ctx: Context, key: string, value: unknown) => {
                    values.set(key, value);
                },
                deleteValue: async (_ctx: Context, key: string) => {
                    values.delete(key);
                },
                transaction: async (
                    _ctx: Context,
                    work: (ctx: Context) => Promise<unknown>,
                ) => await work(_ctx),
            } as never,
            "kv.agent-a.call.scheduling-call.",
        );
        const ctx = withAgentKV(root, callKV);
        const scope = { agent: { id: agentId } } as never;
        const waitTool = (await module.tools(ctx, scope)).find((tool) => tool.name === "wait");
        expect(waitTool).toBeDefined();
        const first = waitTool!.execute(ctx, {
            duration: { unit: "seconds", value: 1 },
        });
        await scheduler.waitStartedFor("s1");
        now.value = 1_500;
        scheduler.settle("s1", {
            waitId: "s1",
            agentId,
            operationId: "s2",
            fingerprint: store.waits.get("s1")!.fingerprint,
            outcome: "interrupted",
            kind: "wait",
            dueAt: store.waits.get("s1")!.dueAt,
            startedAt: 1_000,
            endedAt: 1_500,
            elapsedMs: 500,
        });
        await expect(first).resolves.toMatchObject({ waitId: "s1", operationId: "s2" });
        const restarted = makeModule(store, scheduler, { value: 1_500 });
        const restartedTool = (await restarted.tools(ctx, scope)).find(
            (tool) => tool.name === "wait",
        );
        expect(restartedTool).toBeDefined();
        await expect(
            restartedTool!.execute(ctx, {
                duration: { unit: "seconds", value: 1 },
            }),
        ).resolves.toMatchObject({ waitId: "s1", operationId: "s2", elapsedMs: 500 });
        expect(Value.Check(schedulingScheduledMessageSchema, {
            id: "tool-check",
            senderAgentId: agentId,
            targetAgentId: agentId,
            message: "x",
            dueAt: 1_000,
            status: "pending",
            operationId: "tool-operation",
            fingerprint: "{}",
            createdAt: 1_000,
            updatedAt: 1_000,
        })).toBe(true);
    });
});