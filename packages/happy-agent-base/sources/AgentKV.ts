import { asyncLock, withLifetime, type AsyncLock, type Context } from "@steve.kite/stdlib";

import type { AgentPersistence } from "./AgentPersistence.js";

/**
 * A key-value store scoped under one prefix of the agent's sorted store. The agent carries a
 * session-scoped instance on its context, and narrows it for each caller: a module works
 * under its own name, a tool execution under its call ID. Keys are always relative to the
 * scope — a holder can neither see nor touch anything outside it. Segments join with `.`.
 *
 * Every operation runs on the context it is given, so that context decides which transaction a
 * write joins. Most handles also take their lifetime from that context; explicitly bounded
 * handles, such as a tool call's KV, additionally become unusable when their owner ends.
 */
export class AgentKV {
    /** The absolute key prefix of this scope, ending with the separator. */
    readonly prefix: string;

    /** The append-only store this scope reads and writes through. */
    readonly #persistence: AgentPersistence;
    /** An object-owned lifetime used by bounded stores such as one tool invocation's KV. */
    readonly #available: () => boolean;
    /** Serializes this scope tree so disposal always follows every write that already started. */
    readonly #lock: AsyncLock | undefined;

    /** Build a scope over `prefix` of `persistence`. */
    constructor(
        persistence: AgentPersistence,
        prefix: string,
        available = () => true,
        lock?: AsyncLock,
    ) {
        this.#persistence = persistence;
        this.prefix = prefix;
        this.#available = available;
        this.#lock = lock;
    }

    /**
     * A handle to this scope whose operations serialize with all descendants derived from it.
     * Agent base uses this only for one tool call, so disposal can drain writes already in flight
     * without serializing unrelated module and agent stores.
     *
     * @internal
     */
    serialized(): AgentKV {
        return new AgentKV(
            this.#persistence,
            this.prefix,
            this.#available,
            asyncLock({ reentry: "block" }),
        );
    }

    /**
     * A narrower store under `segments` within this scope. Each segment is exactly one level:
     * a dot inside a segment is escaped, so the scope `alpha.beta` cannot be reached through
     * the scope `alpha` under the relative key `beta.…`, and two scopes stay distinct whenever
     * their segment lists differ.
     */
    scoped(...segments: readonly string[]): AgentKV {
        const escaped = segments.map((segment) =>
            segment.replaceAll("%", "%25").replaceAll(".", "%2E"),
        );
        return new AgentKV(
            this.#persistence,
            `${this.prefix}${escaped.join(".")}.`,
            this.#available,
            this.#lock,
        );
    }

    /**
     * A handle to this exact scope that becomes permanently unusable when `signal` aborts.
     * Narrower scopes inherit the same bound. Agent base uses this for call KV so no context can
     * recreate invocation state after the winning result erases it.
     */
    until(signal: AbortSignal, available = () => true): AgentKV {
        return new AgentKV(
            this.#persistence,
            this.prefix,
            () => this.#available() && !signal.aborted && available(),
            this.#lock,
        );
    }

    /** The stored value, or undefined when the key is absent. */
    async read(ctx: Context, key: string): Promise<unknown> {
        return await this.#locked(ctx, async (lockCtx) => {
            const full = `${this.prefix}${key}`;
            const entries = await this.#persistence.readValues(lockCtx, full);
            return entries.find((entry) => entry.key === full)?.value;
        });
    }

    /** Every entry under the scope — or under `prefix` within it — with scope-relative keys. */
    async list(
        ctx: Context,
        prefix = "",
    ): Promise<readonly { readonly key: string; readonly value: unknown }[]> {
        return await this.#locked(ctx, async (lockCtx) => {
            const entries = await this.#persistence.readValues(lockCtx, `${this.prefix}${prefix}`);
            return entries.map(({ key, value }) => ({
                key: key.slice(this.prefix.length),
                value,
            }));
        });
    }

    /** Store the value under `key`, replacing whatever was there before. */
    async write(ctx: Context, key: string, value: unknown): Promise<void> {
        await this.#locked(ctx, async (lockCtx) => {
            await this.#persistence.writeValue(lockCtx, `${this.prefix}${key}`, value);
        });
    }

    /**
     * Read, decide, and write, so the value the updater sees is exactly the value it replaces.
     * One store has one owner, so nothing else can write between the read and the write. An
     * updater that throws leaves the stored value untouched.
     */
    async update<Value>(
        ctx: Context,
        key: string,
        updater: (current: unknown) => Value | Promise<Value>,
    ): Promise<Value> {
        return await this.#locked(ctx, async (lockCtx) => {
            const full = `${this.prefix}${key}`;
            const entries = await this.#persistence.readValues(lockCtx, full);
            const current = entries.find((entry) => entry.key === full)?.value;
            const next = await updater(current);
            await this.#persistence.writeValue(lockCtx, full, next);
            return next;
        });
    }

    /**
     * Return the durable value already stored under `key`, or create and store it exactly once.
     * The read and possible write share one persistence transaction, and an existing outer
     * transaction is reused. A tool can use this on its call-bound KV for retry-stable operation
     * identities without coupling them to a provider call ID.
     */
    async getOrCreate<Value>(
        ctx: Context,
        key: string,
        create: () => Value | Promise<Value>,
    ): Promise<Value> {
        return await this.#locked(ctx, async (lockCtx) => {
            return await this.#persistence.transaction(lockCtx, async (txCtx) => {
                const full = `${this.prefix}${key}`;
                const entries = await this.#persistence.readValues(txCtx, full);
                const existing = entries.find((entry) => entry.key === full);
                if (existing !== undefined) return existing.value as Value;
                const value = await create();
                if (await this.#persistence.writeValueIfAbsent(txCtx, full, value)) return value;
                const winner = (await this.#persistence.readValues(txCtx, full)).find(
                    (entry) => entry.key === full,
                );
                if (winner === undefined) {
                    throw new Error(
                        "The durable get-or-create value disappeared before it was read.",
                    );
                }
                return winner.value as Value;
            });
        });
    }

    /**
     * Run work as one atomic step of the underlying store: everything it writes commits together,
     * and a thrown error leaves the store exactly as it was. The work is given this same scope and
     * the transaction's context, whose lifetime ends when the work returns, so a transaction
     * cannot be written into after it has committed.
     */
    async transaction<Result>(
        ctx: Context,
        work: (kv: AgentKV, txCtx: Context) => Promise<Result>,
    ): Promise<Result> {
        this.#assertLive(ctx);
        return await this.#persistence.transaction(ctx, async (txCtx) => {
            const committed = new AbortController();
            const liveCtx = withLifetime(txCtx, committed.signal);
            try {
                return await work(this, liveCtx);
            } finally {
                committed.abort();
            }
        });
    }

    /**
     * Remove every entry in this scope, including the ones its narrower scopes wrote. This is how
     * a store whose lifetime has ended is disposed of — the run store when the agent settles — so
     * it runs as one operation of the underlying store and joins a transaction like any other
     * write.
     */
    async clear(ctx: Context): Promise<void> {
        await this.#locked(ctx, async (lockCtx) => {
            const entries = await this.#persistence.readValues(lockCtx, this.prefix);
            for (const entry of entries) {
                await this.#persistence.deleteValue(lockCtx, entry.key);
            }
        });
    }

    /** Remove the entry stored under `key`, if any. */
    async delete(ctx: Context, key: string): Promise<void> {
        await this.#locked(ctx, async (lockCtx) => {
            await this.#persistence.deleteValue(lockCtx, `${this.prefix}${key}`);
        });
    }

    /** Re-check availability only after every earlier operation in this scope tree has finished. */
    async #locked<Result>(ctx: Context, work: (ctx: Context) => Promise<Result>): Promise<Result> {
        if (this.#lock === undefined) {
            this.#assertLive(ctx);
            return await work(ctx);
        }
        return await this.#lock.runInLock(ctx, async (lockCtx) => {
            this.#assertLive(lockCtx);
            return await work(lockCtx);
        });
    }

    /**
     * Refuse a store operation when either its caller-owned context or this bounded handle has
     * ended. The latter is what makes call KV stay erased even if retained code supplies a fresh
     * unrelated context after commit.
     */
    #assertLive(ctx: Context): void {
        if (ctx.lifetime?.aborted === true || !this.#available()) {
            throw new Error("The store cannot be used: the work its context belongs to has ended.");
        }
    }
}
