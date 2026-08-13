import { withLifetime, type Context } from "@steve.kite/stdlib";

import type { AgentPersistence } from "./AgentPersistence.js";

/**
 * Refuse a store operation whose context has already ended. What a holder of a store may do is
 * decided by the context it is given rather than by the object: a store used inside a transaction,
 * or handed to a tool for the length of its turn, keeps working exactly as long as that work
 * does. Using it afterwards is a mistake in the caller, and says so instead of quietly writing
 * into a transaction that has committed or a turn that was cancelled.
 */
function assertLive(ctx: Context): void {
    if (ctx.lifetime?.aborted === true) {
        throw new Error("The store cannot be used: the work its context belongs to has ended.");
    }
}

/**
 * A key-value store scoped under one prefix of the agent's sorted store. The agent carries a
 * session-scoped instance on its context, and narrows it for each caller: a feature works
 * under its own name, a tool execution under its call ID. Keys are always relative to the
 * scope — a holder can neither see nor touch anything outside it. Segments join with `.`.
 *
 * The object is nothing but a scope: every operation runs on the context it is given, so which
 * transaction a write joins and how long the handle stays usable are both decided by that
 * context and never by the handle.
 */
export class AgentKV {
    /** The absolute key prefix of this scope, ending with the separator. */
    readonly prefix: string;

    /** The append-only store this scope reads and writes through. */
    readonly #persistence: AgentPersistence;

    /** Build a scope over `prefix` of `persistence`. */
    constructor(persistence: AgentPersistence, prefix: string) {
        this.#persistence = persistence;
        this.prefix = prefix;
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
        return new AgentKV(this.#persistence, `${this.prefix}${escaped.join(".")}.`);
    }

    /** The stored value, or undefined when the key is absent. */
    async read(ctx: Context, key: string): Promise<unknown> {
        assertLive(ctx);
        const full = `${this.prefix}${key}`;
        const entries = await this.#persistence.readValues(ctx, full);
        return entries.find((entry) => entry.key === full)?.value;
    }

    /** Every entry under the scope — or under `prefix` within it — with scope-relative keys. */
    async list(
        ctx: Context,
        prefix = "",
    ): Promise<readonly { readonly key: string; readonly value: unknown }[]> {
        assertLive(ctx);
        const entries = await this.#persistence.readValues(ctx, `${this.prefix}${prefix}`);
        return entries.map(({ key, value }) => ({ key: key.slice(this.prefix.length), value }));
    }

    /** Store the value under `key`, replacing whatever was there before. */
    async write(ctx: Context, key: string, value: unknown): Promise<void> {
        assertLive(ctx);
        await this.#persistence.writeValue(ctx, `${this.prefix}${key}`, value);
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
        assertLive(ctx);
        const full = `${this.prefix}${key}`;
        const entries = await this.#persistence.readValues(ctx, full);
        const current = entries.find((entry) => entry.key === full)?.value;
        const next = await updater(current);
        await this.#persistence.writeValue(ctx, full, next);
        return next;
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
        assertLive(ctx);
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
        assertLive(ctx);
        const entries = await this.#persistence.readValues(ctx, this.prefix);
        for (const entry of entries) {
            await this.#persistence.deleteValue(ctx, entry.key);
        }
    }

    /** Remove the entry stored under `key`, if any. */
    async delete(ctx: Context, key: string): Promise<void> {
        assertLive(ctx);
        await this.#persistence.deleteValue(ctx, `${this.prefix}${key}`);
    }
}
