import { createContextNamespace, type Context } from "@steve.kite/stdlib";

import type {
    SchedulingMutationProof,
    SchedulingMutationReceipt,
    SchedulingDeliveryOutcomeRequest,
    SchedulingSchedulePage,
    SchedulingSchedulePageQuery,
    SchedulingScheduleRequest,
    SchedulingScheduledMessage,
    SchedulingStore,
    SchedulingTransactionChange,
    SchedulingWaitClaimRequest,
    SchedulingWaitRecord,
    SchedulingWaitResult,
    SchedulingScheduler,
} from "../../../sources/scheduling/index.js";

const transactionContextNamespace = createContextNamespace(
    "scheduling-in-memory-transaction",
    false,
);

export class InMemorySchedulingStore implements SchedulingStore {
    readonly waits = new Map<string, SchedulingWaitRecord>();
    readonly schedules = new Map<string, SchedulingScheduledMessage>();
    readonly receipts = new Map<string, SchedulingMutationReceipt>();
    readonly proofs = new Map<string, SchedulingMutationProof>();
    /** Durable host wait settlements survive replacement of the scheduler instance. */
    readonly waitOutcomes = new Map<string, SchedulingWaitResult>();
    /** Ephemeral subscriptions are shared only to let this double model host reattachment. */
    readonly waitSubscriptions = new Map<
        string,
        Set<(result: SchedulingWaitResult) => void>
    >();
    readonly postCommit: Array<(ctx: Context) => void | Promise<void>> = [];
    depth = 0;
    transactionCount = 0;
    readonly callbacks: Array<(ctx: Context) => void | Promise<void>> = [];
    #tail: Promise<void> = Promise.resolve();
    readonly #activeTransactions = new WeakMap<object, { depth: number }>();

    async transaction(
        ctx: Context,
        _agentId: string,
        work: (ctx: Context) => Promise<SchedulingTransactionChange>,
    ): Promise<SchedulingTransactionChange> {
        const nested = this.#activeTransactions.get(ctx);
        if (nested !== undefined) {
            nested.depth += 1;
            this.depth += 1;
            try {
                return await work(ctx);
            } finally {
                nested.depth -= 1;
                this.depth -= 1;
            }
        }
        const previous = this.#tail;
        let release!: () => void;
        this.#tail = new Promise<void>((resolve) => {
            release = resolve;
        });
        await previous;
        const transactionContext = transactionContextNamespace.set(ctx, true);
        const state = { depth: 1 };
        this.#activeTransactions.set(transactionContext, state);
        this.depth = 1;
        this.transactionCount += 1;
        const waits = structuredClone(this.waits);
        const schedules = structuredClone(this.schedules);
        const receipts = structuredClone(this.receipts);
        const proofs = structuredClone(this.proofs);
        const waitOutcomes = structuredClone(this.waitOutcomes);
        let result: SchedulingTransactionChange;
        try {
            result = await work(transactionContext);
        } catch (error) {
            this.waits.clear();
            for (const [key, value] of waits) this.waits.set(key, value);
            this.schedules.clear();
            for (const [key, value] of schedules) this.schedules.set(key, value);
            this.receipts.clear();
            for (const [key, value] of receipts) this.receipts.set(key, value);
            this.proofs.clear();
            for (const [key, value] of proofs) this.proofs.set(key, value);
            this.waitOutcomes.clear();
            for (const [key, value] of waitOutcomes) this.waitOutcomes.set(key, value);
            this.postCommit.splice(0);
            this.#activeTransactions.delete(transactionContext);
            this.depth = 0;
            release();
            throw error;
        }
        // The durable state is committed before callbacks run. A callback may therefore start
        // another transaction, and a callback failure cannot roll back what was published.
        this.#activeTransactions.delete(transactionContext);
        this.depth = 0;
        release();
        const callbacks = this.postCommit.splice(0);
        for (const callback of callbacks) await callback(transactionContext);
        return result;
    }

    afterCommit(
        _ctx: Context,
        callback: (ctx: Context) => void | Promise<void>,
    ): void {
        this.postCommit.push(callback);
    }

    async readWait(
        _ctx: Context,
        _agentId: string,
        id: string,
    ): Promise<SchedulingWaitRecord | undefined> {
        const value = this.waits.get(id);
        return value === undefined ? undefined : structuredClone(value);
    }

    async writeWait(_ctx: Context, wait: SchedulingWaitRecord): Promise<void> {
        this.waits.set(wait.id, structuredClone(wait));
    }

    async readSchedule(
        _ctx: Context,
        _agentId: string,
        id: string,
    ): Promise<SchedulingScheduledMessage | undefined> {
        const value = this.schedules.get(id);
        return value === undefined ? undefined : structuredClone(value);
    }

    async writeSchedule(_ctx: Context, schedule: SchedulingScheduledMessage): Promise<void> {
        this.schedules.set(schedule.id, structuredClone(schedule));
    }

    async listSchedules(
        _ctx: Context,
        _agentId: string,
        query: SchedulingSchedulePageQuery,
    ): Promise<SchedulingSchedulePage> {
        const start = query.cursor === undefined ? 0 : Number(query.cursor);
        const values = [...this.schedules.values()]
            .filter(
                (schedule) =>
                    (query.senderAgentId === undefined ||
                        schedule.senderAgentId === query.senderAgentId) &&
                    (query.targetAgentId === undefined ||
                        schedule.targetAgentId === query.targetAgentId) &&
                    (query.status === undefined || schedule.status === query.status),
            )
            .sort((left, right) => left.id.localeCompare(right.id));
        const limit = query.limit ?? 50;
        const schedules = values.slice(start, start + limit).map((value) => structuredClone(value));
        return {
            schedules,
            limit,
            ...(start + schedules.length < values.length
                ? { nextCursor: String(start + schedules.length) }
                : {}),
            ...(start > 0 ? { previousCursor: String(Math.max(0, start - limit)) } : {}),
        };
    }

    async readReceipt(
        _ctx: Context,
        _agentId: string,
        operationId: string,
    ): Promise<SchedulingMutationReceipt | undefined> {
        const value = this.receipts.get(operationId);
        return value === undefined ? undefined : structuredClone(value);
    }

    async writeReceipt(_ctx: Context, receipt: SchedulingMutationReceipt): Promise<void> {
        this.receipts.set(receipt.operationId, structuredClone(receipt));
    }

    async readMutationProof(
        _ctx: Context,
        _agentId: string,
        operationId: string,
    ): Promise<SchedulingMutationProof | undefined> {
        const value = this.proofs.get(operationId);
        return value === undefined ? undefined : structuredClone(value);
    }

    async writeMutationProof(_ctx: Context, proof: SchedulingMutationProof): Promise<void> {
        this.proofs.set(proof.operationId, structuredClone(proof));
    }
}

export class InMemorySchedulingScheduler implements SchedulingScheduler {
    readonly #store: InMemorySchedulingStore;
    readonly waiters = new Map<string, Promise<SchedulingWaitResult>>();
    readonly #resolvers = new Map<string, (result: SchedulingWaitResult) => void>();
    readonly #waitStartedResolvers = new Map<string, () => void>();
    readonly waitStarted: Promise<void>;
    #resolveWaitStarted!: () => void;
    readonly calls: string[] = [];

    constructor(store: InMemorySchedulingStore) {
        this.#store = store;
        this.waitStarted = new Promise<void>((resolve) => {
            this.#resolveWaitStarted = resolve;
        });
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

    async wait(
        _ctx: Context,
        _agentId: string,
        waitId: string,
    ): Promise<SchedulingWaitResult> {
        this.calls.push("wait");
        if (this.#store.depth !== 0) {
            throw new Error("durable wait started while a store transaction was open");
        }
        this.#resolveWaitStarted();
        this.#waitStartedResolvers.get(waitId)?.();
        this.#waitStartedResolvers.delete(waitId);
        const outcome = this.#store.waitOutcomes.get(waitId);
        if (outcome !== undefined) {
            const promise = Promise.resolve(structuredClone(outcome));
            this.waiters.set(waitId, promise);
            return await promise;
        }
        const existing = this.waiters.get(waitId);
        if (existing !== undefined) return await existing;
        let resolve!: (result: SchedulingWaitResult) => void;
        const promise = new Promise<SchedulingWaitResult>((done) => {
            resolve = done;
        });
        this.waiters.set(waitId, promise);
        this.#resolvers.set(waitId, resolve);
        const subscriptions =
            this.#store.waitSubscriptions.get(waitId) ??
            new Set<(result: SchedulingWaitResult) => void>();
        subscriptions.add((result) => {
            resolve(structuredClone(result));
            this.waiters.set(waitId, Promise.resolve(structuredClone(result)));
            this.#resolvers.delete(waitId);
        });
        this.#store.waitSubscriptions.set(waitId, subscriptions);
        return await promise;
    }

    async waitStartedFor(waitId: string): Promise<void> {
        if (this.waiters.has(waitId)) return;
        await new Promise<void>((resolve) => {
            this.#waitStartedResolvers.set(waitId, resolve);
        });
    }

    settle(waitId: string, result: SchedulingWaitResult): void {
        if (!this.waiters.has(waitId)) throw new Error(`No waiter ${waitId}.`);
        const settled = structuredClone(result);
        this.#store.waitOutcomes.set(waitId, settled);
        const subscriptions = this.#store.waitSubscriptions.get(waitId);
        if (subscriptions !== undefined) {
            this.#store.waitSubscriptions.delete(waitId);
            for (const notify of subscriptions) notify(settled);
        }
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
            operationId: request.operationId,
            fingerprint: request.fingerprint,
            dueAt: request.dueAt,
            status: "pending",
            createdAt: now,
            updatedAt: now,
        };
        await this.#store.writeSchedule(ctx, schedule);
        return schedule;
    }

    async cancel(
        ctx: Context,
        _agentId: string,
        input: { scheduleId: string; operationId?: string },
    ): Promise<SchedulingScheduledMessage> {
        this.calls.push("cancel");
        const current = await this.#store.readSchedule(ctx, _agentId, input.scheduleId);
        if (current === undefined) throw new Error("missing schedule");
        const next: SchedulingScheduledMessage = {
            ...current,
            status: "cancelled",
            updatedAt: current.updatedAt + 1,
        };
        await this.#store.writeSchedule(ctx, next);
        return next;
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
                      failure: input.failure ?? "delivery failed",
                  };
        await this.#store.writeSchedule(ctx, next);
        return next;
    }
}