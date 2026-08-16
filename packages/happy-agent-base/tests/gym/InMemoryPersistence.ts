import { createContextNamespace, withAfterCommit, type Context } from "@steve.kite/stdlib";

import type { AgentPersistence, AgentRecord } from "../../sources/index.js";
import { inMemoryDrizzle } from "./InMemoryDrizzle.js";

export const inMemoryPersistenceDatabase = inMemoryDrizzle().database;

interface StagedTransaction {
    readonly owner: InMemoryPersistence;
    cleared: boolean;
    readonly records: AgentRecord[];
    readonly writes: Map<string, unknown>;
    readonly deletes: Set<string>;
}

// How a transaction rides on the context is this implementation's own business; the agent only
// passes the derived context back into the operations.
const stagedNamespace = createContextNamespace<StagedTransaction | undefined>(
    "inMemoryPersistenceTransaction",
    undefined,
    // Not detachable, exactly like the storage transaction the real persistence carries.
    { detachable: false },
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
    readonly database = inMemoryPersistenceDatabase;
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
        return new Map(
            [...this.values].filter(
                ([key]) =>
                    key !== "context" &&
                    key !== "owed" &&
                    key !== "agentConfig" &&
                    !key.startsWith("message."),
            ),
        );
    }

    async transaction<Result>(
        ctx: Context,
        work: (ctx: Context) => Promise<Result>,
    ): Promise<Result> {
        const existing = this.#staged(ctx);
        if (existing !== undefined) return await work(ctx);
        const staged: StagedTransaction = {
            owner: this,
            cleared: false,
            records: [],
            writes: new Map(),
            deletes: new Set(),
        };
        const [transactionCtx, runAfterCommit] = withAfterCommit(stagedNamespace.set(ctx, staged));
        const result = await work(transactionCtx);
        if (staged.cleared) this.records.length = 0;
        this.records.push(...staged.records);
        for (const [key, value] of staged.writes) this.values.set(key, value);
        for (const key of staged.deletes) this.values.delete(key);
        await runAfterCommit();
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

    async writeValueIfAbsent(ctx: Context, key: string, value: unknown): Promise<boolean> {
        if ((await this.readValues(ctx, key)).some((entry) => entry.key === key)) return false;
        await this.writeValue(ctx, key, value);
        return true;
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
