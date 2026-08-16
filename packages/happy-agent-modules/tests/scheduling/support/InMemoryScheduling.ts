import type { Context } from "@steve.kite/stdlib";

import type {
    SchedulingCancelInput,
    SchedulingDeliveryOutcomeRequest,
    SchedulingSchedulePage,
    SchedulingSchedulePageQuery,
    SchedulingScheduledMessage,
    SchedulingWaitRecord,
    SchedulingWaitResult,
} from "../../../sources/scheduling/Scheduling.js";
import type {
    SchedulingScheduleRequest,
    SchedulingScheduler,
    SchedulingStore,
    SchedulingWaitClaimRequest,
} from "../../../sources/scheduling/SchedulingStore.js";

function clone<Value>(value: Value): Value {
    return structuredClone(value);
}

export class InMemorySchedulingStore implements SchedulingStore {
    readonly waits = new Map<string, SchedulingWaitRecord>();
    readonly schedules = new Map<string, SchedulingScheduledMessage>();
    readonly waitOutcomes = new Map<string, SchedulingWaitResult>();
    readonly waitSubscriptions = new Map<string, Set<(result: SchedulingWaitResult) => void>>();
    async readWait(
        _ctx: Context,
        agentId: string,
        id: string,
    ): Promise<SchedulingWaitRecord | undefined> {
        const value = this.waits.get(id);
        if (value === undefined || value.agentId !== agentId) return undefined;
        return clone(value);
    }

    async writeWait(_ctx: Context, wait: SchedulingWaitRecord): Promise<void> {
        this.waits.set(wait.id, clone(wait));
    }

    async readSchedule(
        _ctx: Context,
        agentId: string,
        id: string,
    ): Promise<SchedulingScheduledMessage | undefined> {
        const value = this.schedules.get(id);
        if (
            value === undefined ||
            (value.senderAgentId !== agentId && value.targetAgentId !== agentId)
        ) {
            return undefined;
        }
        return clone(value);
    }

    async writeSchedule(_ctx: Context, schedule: SchedulingScheduledMessage): Promise<void> {
        this.schedules.set(schedule.id, clone(schedule));
    }

    async listSchedules(
        _ctx: Context,
        _agentId: string,
        query: SchedulingSchedulePageQuery,
    ): Promise<SchedulingSchedulePage> {
        const start = query.cursor === undefined ? 0 : Number(query.cursor);
        const limit = query.limit ?? 50;
        const values = [...this.schedules.values()]
            .filter(
                (schedule) =>
                    (query.senderAgentId === undefined ||
                        schedule.senderAgentId === query.senderAgentId) &&
                    (query.targetAgentId === undefined ||
                        schedule.targetAgentId === query.targetAgentId) &&
                    (query.status === undefined || schedule.status === query.status),
            )
            .sort((left, right) => left.dueAt - right.dueAt || left.id.localeCompare(right.id));
        const schedules = values.slice(start, start + limit).map(clone);
        return {
            schedules,
            limit,
            ...(start > 0 ? { previousCursor: String(Math.max(0, start - limit)) } : {}),
            ...(start + schedules.length < values.length
                ? { nextCursor: String(start + schedules.length) }
                : {}),
        };
    }
}

export class InMemorySchedulingScheduler implements SchedulingScheduler {
    readonly calls: string[] = [];
    readonly #store: InMemorySchedulingStore;
    readonly #waiters = new Map<string, Promise<SchedulingWaitResult>>();
    readonly #resolvers = new Map<string, (result: SchedulingWaitResult) => void>();
    readonly #started = new Map<string, () => void>();

    constructor(store: InMemorySchedulingStore) {
        this.#store = store;
    }

    async startWait(
        ctx: Context,
        _agentId: string,
        request: SchedulingWaitClaimRequest,
    ): Promise<SchedulingWaitRecord> {
        this.calls.push("startWait");
        const existing = await this.#store.readWait(ctx, request.agentId, request.id);
        if (existing !== undefined) return existing;
        const wait: SchedulingWaitRecord = {
            ...request,
            createdAt: request.startedAt,
            updatedAt: request.startedAt,
            status: "waiting",
        };
        await this.#store.writeWait(ctx, wait);
        return wait;
    }

    async wait(_ctx: Context, _agentId: string, waitId: string): Promise<SchedulingWaitResult> {
        this.calls.push("wait");
        this.#started.get(waitId)?.();
        this.#started.delete(waitId);
        const outcome = this.#store.waitOutcomes.get(waitId);
        if (outcome !== undefined) return clone(outcome);
        const active = this.#waiters.get(waitId);
        if (active !== undefined) return await active;
        let resolve!: (result: SchedulingWaitResult) => void;
        const pending = new Promise<SchedulingWaitResult>((done) => {
            resolve = done;
        });
        this.#waiters.set(waitId, pending);
        this.#resolvers.set(waitId, resolve);
        const subscriptions =
            this.#store.waitSubscriptions.get(waitId) ??
            new Set<(result: SchedulingWaitResult) => void>();
        subscriptions.add((result) => {
            resolve(clone(result));
            this.#resolvers.delete(waitId);
            this.#waiters.set(waitId, Promise.resolve(clone(result)));
        });
        this.#store.waitSubscriptions.set(waitId, subscriptions);
        return await pending;
    }

    async waitStartedFor(waitId: string): Promise<void> {
        if (this.#waiters.has(waitId)) return;
        await new Promise<void>((resolve) => {
            this.#started.set(waitId, resolve);
        });
    }

    settle(waitId: string, result: SchedulingWaitResult): void {
        const subscriptions = this.#store.waitSubscriptions.get(waitId);
        if (subscriptions === undefined) throw new Error(`No waiter ${waitId}.`);
        const settled = clone(result);
        this.#store.waitOutcomes.set(waitId, settled);
        this.#store.waitSubscriptions.delete(waitId);
        for (const notify of subscriptions) notify(settled);
    }

    async schedule(
        ctx: Context,
        _agentId: string,
        request: SchedulingScheduleRequest,
    ): Promise<SchedulingScheduledMessage> {
        this.calls.push("schedule");
        const now = Math.max(0, request.dueAt - 1);
        const schedule: SchedulingScheduledMessage = {
            id: request.id,
            senderAgentId: request.senderAgentId,
            targetAgentId: request.targetAgentId,
            message: request.message,
            dueAt: request.dueAt,
            status: "pending",
            createdAt: now,
            updatedAt: now,
        };
        await this.#store.writeSchedule(ctx, schedule);
        return clone(schedule);
    }

    async cancel(
        ctx: Context,
        agentId: string,
        input: SchedulingCancelInput,
    ): Promise<SchedulingScheduledMessage> {
        this.calls.push("cancel");
        const current = await this.#store.readSchedule(ctx, agentId, input.scheduleId);
        if (current === undefined) throw new Error("missing schedule");
        const next: SchedulingScheduledMessage = {
            ...current,
            status: "cancelled",
            updatedAt: current.updatedAt + 1,
        };
        await this.#store.writeSchedule(ctx, next);
        return clone(next);
    }

    async reportDelivery(
        ctx: Context,
        agentId: string,
        input: SchedulingDeliveryOutcomeRequest,
    ): Promise<SchedulingScheduledMessage> {
        this.calls.push("delivery");
        const current = await this.#store.readSchedule(ctx, agentId, input.scheduleId);
        if (current === undefined) throw new Error("missing schedule");
        const updatedAt = current.updatedAt + 1;
        const next: SchedulingScheduledMessage =
            input.status === "delivered"
                ? {
                      ...current,
                      status: "delivered",
                      updatedAt,
                      deliveredAt: input.deliveredAt ?? updatedAt,
                  }
                : {
                      ...current,
                      status: "undelivered",
                      updatedAt,
                      failure: input.failure,
                  };
        await this.#store.writeSchedule(ctx, next);
        return clone(next);
    }
}
