import type { Context } from "@steve.kite/stdlib";

import type { AgentBasePersistence } from "./AgentBasePersistence.js";

/** How a store executes one operation; the agent binds this to its persistence lock. */
export type AgentBaseKVRunner = <Result>(
    ctx: Context,
    work: (ctx: Context) => Promise<Result>,
) => Promise<Result>;

/**
 * A key-value store scoped under one prefix of the agent's sorted store. The agent carries a
 * session-scoped instance on its context, and narrows it for each caller: a feature works
 * under its own name, a tool execution under its call ID. Keys are always relative to the
 * scope — a holder can neither see nor touch anything outside it. Segments join with `.`.
 */
export class AgentBaseKV {
    /** The absolute key prefix of this scope, ending with the separator. */
    readonly prefix: string;

    readonly #persistence: AgentBasePersistence;
    readonly #run: AgentBaseKVRunner;
    #released = false;

    constructor(persistence: AgentBasePersistence, prefix: string, run: AgentBaseKVRunner) {
        this.#persistence = persistence;
        this.prefix = prefix;
        this.#run = run;
    }

    /**
     * A narrower store under `segments` within this scope. Each segment is exactly one level:
     * a dot inside a segment is escaped, so the scope `alpha.beta` cannot be reached through
     * the scope `alpha` under the relative key `beta.…`, and two scopes stay distinct whenever
     * their segment lists differ.
     */
    scoped(...segments: readonly string[]): AgentBaseKV {
        const escaped = segments.map((segment) =>
            segment.replaceAll("%", "%25").replaceAll(".", "%2E"),
        );
        return new AgentBaseKV(this.#persistence, `${this.prefix}${escaped.join(".")}.`, this.#run);
    }

    /**
     * The same scope executing directly on an already-serialized context, for hooks the agent
     * invokes while it is holding its persistence lock — going through the lock again there
     * would deadlock.
     *
     * The shortcut is a capability lent for the span of that one call, and `release` takes it
     * back: afterwards the handle does nothing at all, the way a handle to a finished
     * transaction does. It cannot be allowed to keep working, because the only context it can
     * run on is a lock hold that has already moved on — every later use would either bypass the
     * agent's serialization or write into someone else's transaction.
     */
    locked(lockCtx: Context): { readonly kv: AgentBaseKV; readonly release: () => void } {
        const kv = new AgentBaseKV(this.#persistence, this.prefix, async (_ctx, work) =>
            work(lockCtx),
        );
        return {
            kv,
            release: () => {
                kv.#released = true;
            },
        };
    }

    /** The stored value, or undefined when the key is absent. */
    async read(ctx: Context, key: string): Promise<unknown> {
        if (this.#released) return undefined;
        const full = `${this.prefix}${key}`;
        return await this.#run(ctx, async (opCtx) => {
            const entries = await this.#persistence.readValues(opCtx, full);
            return entries.find((entry) => entry.key === full)?.value;
        });
    }

    /** Every entry under the scope — or under `prefix` within it — with scope-relative keys. */
    async list(
        ctx: Context,
        prefix = "",
    ): Promise<readonly { readonly key: string; readonly value: unknown }[]> {
        if (this.#released) return [];
        return await this.#run(ctx, async (opCtx) => {
            const entries = await this.#persistence.readValues(opCtx, `${this.prefix}${prefix}`);
            return entries.map(({ key, value }) => ({
                key: key.slice(this.prefix.length),
                value,
            }));
        });
    }

    async write(ctx: Context, key: string, value: unknown): Promise<void> {
        if (this.#released) return;
        await this.#run(ctx, (opCtx) =>
            this.#persistence.writeValue(opCtx, `${this.prefix}${key}`, value),
        );
    }

    /**
     * Read, decide, and write, so that the value the updater sees is exactly the value it
     * replaces. This store's lock alone cannot promise that, since another owner over the same
     * storage holds a different lock — so the write is conditional on the value not having moved,
     * and an updater whose read went stale is asked again with the value that won. That is why
     * the updater must be free of side effects: it may run more than once. One that throws leaves
     * the stored value untouched.
     */
    async update<Value>(
        ctx: Context,
        key: string,
        updater: (current: unknown) => Value | Promise<Value>,
    ): Promise<Value> {
        if (this.#released) return await updater(undefined);
        const full = `${this.prefix}${key}`;
        return await this.#run(ctx, async (opCtx) => {
            while (true) {
                const entries = await this.#persistence.readValues(opCtx, full);
                const current = entries.find((entry) => entry.key === full)?.value;
                const next = await updater(current);
                const written = await this.#persistence.writeValueIfUnchanged(
                    opCtx,
                    full,
                    current,
                    next,
                );
                if (written) return next;
            }
        });
    }

    /**
     * Run work as one atomic step of the underlying store: everything it writes commits together,
     * and a thrown error leaves the store exactly as it was. The handle the work is given runs
     * directly on the transaction — going through this store's runner again would be a second
     * entry into a hold this call already has — and stops working once the work returns, so a
     * transaction cannot be written into after it has committed.
     */
    async transaction<Result>(ctx: Context, work: (kv: AgentBaseKV) => Promise<Result>) {
        return await this.#run(ctx, (opCtx) =>
            this.#persistence.transaction(opCtx, async (txCtx) => {
                const { kv, release } = this.locked(txCtx);
                try {
                    return await work(kv);
                } finally {
                    release();
                }
            }),
        );
    }

    /**
     * Claim a key: writes only when it is absent, and answers whether this caller claimed it.
     * Two callers racing for one key cannot both be told they wrote it.
     */
    async writeIfAbsent(ctx: Context, key: string, value: unknown): Promise<boolean> {
        if (this.#released) return false;
        return await this.#run(ctx, (opCtx) =>
            this.#persistence.writeValueIfAbsent(opCtx, `${this.prefix}${key}`, value),
        );
    }

    async delete(ctx: Context, key: string): Promise<void> {
        if (this.#released) return;
        await this.#run(ctx, (opCtx) =>
            this.#persistence.deleteValue(opCtx, `${this.prefix}${key}`),
        );
    }
}
