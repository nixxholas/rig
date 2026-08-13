import { createContextNamespace, deterministicStringify, type Context } from "@steve.kite/stdlib";

import type { AgentPersistence, AgentRecord } from "../../sources/index.js";

interface StagedTransaction {
    readonly owner: InMemoryPersistence;
    cleared: boolean;
    readonly records: AgentRecord[];
    readonly writes: Map<string, unknown>;
    readonly deletes: Set<string>;
    /** Committed entries this transaction claimed eagerly, kept so a rollback can restore them. */
    readonly claims: Map<string, unknown>;
}

// How a transaction rides on the context is this implementation's own business; the agent only
// passes the derived context back into the operations.
const stagedNamespace = createContextNamespace<StagedTransaction | undefined>(
    "inMemoryPersistenceTransaction",
    undefined,
);

/**
 * A real store serializes what it is given, so nothing the agent keeps in memory can change a
 * record after it was written. This one copies for the same reason: a test store that held the
 * agent's own arrays would quietly follow along with them and hide exactly the kind of aliasing
 * bug it exists to catch.
 */
function stored<Value>(value: Value): Value {
    return structuredClone(value);
}

/**
 * In-memory main context store plus sorted key-value store, optionally pre-seeded with prior
 * history. Operations inside a transaction stage their effects on the context-carried
 * transaction and apply them only at commit.
 */
export class InMemoryPersistence implements AgentPersistence {
    readonly records: AgentRecord[];
    readonly values = new Map<string, unknown>();
    loads = 0;

    constructor(records: AgentRecord[] = []) {
        this.records = records;
    }

    /**
     * Every durable value except the agent's own bookkeeping — the measured context size and the
     * settle marker — which record what the agent knows rather than work still owed.
     */
    get pending(): Map<string, unknown> {
        return new Map([...this.values].filter(([key]) => key !== "context" && key !== "owed"));
    }

    async transaction<Result>(
        ctx: Context,
        work: (ctx: Context) => Promise<Result>,
    ): Promise<Result> {
        const staged: StagedTransaction = {
            owner: this,
            cleared: false,
            records: [],
            writes: new Map(),
            deletes: new Set(),
            claims: new Map(),
        };
        let result: Result;
        try {
            result = await work(stagedNamespace.set(ctx, staged));
        } catch (error) {
            // A claim takes effect the moment it is made, so an abandoned transaction has to
            // give back every entry it took.
            for (const [key, value] of staged.claims) this.values.set(key, value);
            throw error;
        }
        if (staged.cleared) this.records.length = 0;
        this.records.push(...staged.records);
        for (const [key, value] of staged.writes) this.values.set(key, value);
        for (const key of staged.deletes) this.values.delete(key);
        return result;
    }

    clearRecords(ctx: Context): Promise<void> {
        const staged = this.#staged(ctx);
        if (staged === undefined) {
            this.records.length = 0;
        } else {
            staged.cleared = true;
            staged.records.length = 0;
        }
        return Promise.resolve();
    }

    load(): Promise<readonly AgentRecord[]> {
        this.loads += 1;
        return Promise.resolve(this.records.map((record) => stored(record)));
    }

    append(ctx: Context, record: AgentRecord): Promise<void> {
        const staged = this.#staged(ctx);
        if (staged === undefined) {
            this.records.push(stored(record));
        } else {
            staged.records.push(stored(record));
        }
        return Promise.resolve();
    }

    readValues(
        ctx: Context,
        prefix: string,
    ): Promise<readonly { readonly key: string; readonly value: unknown }[]> {
        const staged = this.#staged(ctx);
        const merged = new Map(this.values);
        if (staged !== undefined) {
            for (const [key, value] of staged.writes) merged.set(key, value);
            for (const key of staged.deletes) merged.delete(key);
        }
        const entries = [...merged.entries()]
            .filter(([key]) => key.startsWith(prefix))
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([key, value]) => ({ key, value: stored(value) }));
        return Promise.resolve(entries);
    }

    writeValue(ctx: Context, key: string, value: unknown): Promise<void> {
        const staged = this.#staged(ctx);
        if (staged === undefined) {
            this.values.set(key, stored(value));
        } else {
            staged.writes.set(key, stored(value));
            staged.deletes.delete(key);
        }
        return Promise.resolve();
    }

    /**
     * The check and the write happen together, without awaiting in between, so two callers
     * racing for one key can never both be told they wrote it.
     */
    writeValueIfAbsent(ctx: Context, key: string, value: unknown): Promise<boolean> {
        const staged = this.#staged(ctx);
        const present =
            staged === undefined
                ? this.values.has(key)
                : (this.values.has(key) || staged.writes.has(key)) && !staged.deletes.has(key);
        if (present) return Promise.resolve(false);
        return this.writeValue(ctx, key, value).then(() => true);
    }

    /**
     * The comparison and the write happen together, without awaiting in between, so of two
     * owners deciding from one value only the first to write is told it wrote.
     */
    writeValueIfUnchanged(
        ctx: Context,
        key: string,
        expected: unknown,
        value: unknown,
    ): Promise<boolean> {
        const staged = this.#staged(ctx);
        const current =
            staged === undefined
                ? this.values.get(key)
                : staged.deletes.has(key)
                  ? undefined
                  : (staged.writes.get(key) ?? this.values.get(key));
        if (deterministicStringify(current) !== deterministicStringify(expected)) {
            return Promise.resolve(false);
        }
        return this.writeValue(ctx, key, value).then(() => true);
    }

    /**
     * The check and the deletion happen together, without awaiting in between, and the entry
     * leaves the committed store at once so a concurrent owner cannot also claim it.
     */
    deleteValueIfPresent(ctx: Context, key: string): Promise<boolean> {
        const staged = this.#staged(ctx);
        if (staged === undefined) {
            const present = this.values.has(key);
            this.values.delete(key);
            return Promise.resolve(present);
        }
        if (staged.deletes.has(key)) return Promise.resolve(false);
        if (!staged.writes.has(key) && !this.values.has(key)) return Promise.resolve(false);
        if (this.values.has(key)) {
            // The claim leaves the committed store at once, so a concurrent owner cannot also
            // take it; the transaction's rollback is what puts it back.
            staged.claims.set(key, this.values.get(key));
            this.values.delete(key);
        }
        return this.deleteValue(ctx, key).then(() => true);
    }

    deleteValue(ctx: Context, key: string): Promise<void> {
        const staged = this.#staged(ctx);
        if (staged === undefined) {
            this.values.delete(key);
        } else {
            staged.deletes.add(key);
            staged.writes.delete(key);
        }
        return Promise.resolve();
    }

    #staged(ctx: Context): StagedTransaction | undefined {
        const transaction = stagedNamespace.get(ctx);
        return transaction?.owner === this ? transaction : undefined;
    }
}
