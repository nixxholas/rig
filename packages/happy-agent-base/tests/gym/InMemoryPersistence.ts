import { createContextNamespace, type Context } from "@steve.kite/stdlib";

import type { AgentBasePersistence, AgentBaseRecord } from "../../sources/index.js";

interface StagedTransaction {
    readonly owner: InMemoryPersistence;
    cleared: boolean;
    readonly records: AgentBaseRecord[];
    readonly writes: Map<string, unknown>;
    readonly deletes: Set<string>;
}

// How a transaction rides on the context is this implementation's own business; the agent only
// passes the derived context back into the operations.
const stagedNamespace = createContextNamespace<StagedTransaction | undefined>(
    "inMemoryPersistenceTransaction",
    undefined,
);

/**
 * In-memory main context store plus sorted key-value store, optionally pre-seeded with prior
 * history. Operations inside a transaction stage their effects on the context-carried
 * transaction and apply them only at commit.
 */
export class InMemoryPersistence implements AgentBasePersistence {
    readonly records: AgentBaseRecord[];
    readonly values = new Map<string, unknown>();
    loads = 0;

    constructor(records: AgentBaseRecord[] = []) {
        this.records = records;
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
        };
        const result = await work(stagedNamespace.set(ctx, staged));
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

    load(): Promise<readonly AgentBaseRecord[]> {
        this.loads += 1;
        return Promise.resolve([...this.records]);
    }

    append(ctx: Context, record: AgentBaseRecord): Promise<void> {
        const staged = this.#staged(ctx);
        if (staged === undefined) {
            this.records.push(record);
        } else {
            staged.records.push(record);
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
            .map(([key, value]) => ({ key, value }));
        return Promise.resolve(entries);
    }

    writeValue(ctx: Context, key: string, value: unknown): Promise<void> {
        const staged = this.#staged(ctx);
        if (staged === undefined) {
            this.values.set(key, value);
        } else {
            staged.writes.set(key, value);
            staged.deletes.delete(key);
        }
        return Promise.resolve();
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
