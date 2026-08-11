import { chmod, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

import {
    MAXIMUM_STORE_SCAN_ITEMS,
    type MurmurStore,
    type StoreScanOptions,
    type StoreTransaction,
} from "@slopus/murmur";
import { createClient, type Client, type InStatement, type ResultSet } from "@libsql/client";
import type { Context } from "@steve.kite/stdlib";
import { withWorkerContext } from "../../observability/daemonContext.js";

import { asyncLock, type AsyncLock } from "../../concurrency/index.js";
import { createHeldMemorySqliteClient } from "../database/createHeldMemorySqliteClient.js";
import { runSqliteTransactionBody } from "./runSqliteTransaction.js";

interface MurmurStoreRow {
    key: string;
    value: ArrayBuffer | Uint8Array;
}

type SqlExecutor = {
    execute(statement: InStatement): Promise<ResultSet>;
};

type StoreLifecycle = "open" | "closing" | "closed";

export class SqliteMurmurStore implements MurmurStore {
    readonly #client: Client;
    readonly #lock: AsyncLock = asyncLock({ reentry: "block" });
    readonly #ready: Promise<void>;
    #lifecycle: StoreLifecycle = "open";
    #closePromise: Promise<void> | undefined;

    constructor(path: string) {
        this.#client = createMurmurClient(path);
        this.#ready = withWorkerContext("murmur-store-initialize", (ctx) =>
            this.#initialize(ctx, path),
        );
    }

    get(key: string): Promise<Uint8Array | undefined> {
        return this.#run((database) => this.#get(database, key));
    }

    set(key: string, value: Uint8Array): Promise<void> {
        return this.#run((database) => this.#set(database, key, value));
    }

    delete(key: string): Promise<void> {
        return this.#run((database) => this.#delete(database, key));
    }

    list(prefix: string): Promise<ReadonlyMap<string, Uint8Array>> {
        return this.#run((database) =>
            this.#scan(database, prefix, { limit: MAXIMUM_STORE_SCAN_ITEMS }),
        );
    }

    scan(prefix: string, options: StoreScanOptions): Promise<ReadonlyMap<string, Uint8Array>> {
        return this.#run((database) => this.#scan(database, prefix, options));
    }

    transaction<Result>(
        operation: (transaction: StoreTransaction) => Promise<Result>,
    ): Promise<Result> {
        return this.#run(async (database) => {
            // libSQL's local `transaction()` detaches its SQLite connection from
            // the client, but its transaction handle never closes that connection
            // after commit. The native connection then survives until garbage
            // collection, retaining the database and WAL descriptors meanwhile.
            // This store already owns an exclusive lock, so use the client's one
            // connection directly and keep its lifetime tied to the store.
            await database.execute("BEGIN IMMEDIATE");
            let active = true;
            const runInTransaction = <Result>(operation: () => Promise<Result>): Promise<Result> =>
                active ? operation() : Promise.reject(new Error("Murmur transaction is closed"));
            const transaction: StoreTransaction = {
                delete: (key) => runInTransaction(() => this.#delete(database, key)),
                get: (key) => runInTransaction(() => this.#get(database, key)),
                list: (prefix) =>
                    runInTransaction(() =>
                        this.#scan(database, prefix, { limit: MAXIMUM_STORE_SCAN_ITEMS }),
                    ),
                scan: (prefix, options) =>
                    runInTransaction(() => this.#scan(database, prefix, options)),
                set: (key, value) => runInTransaction(() => this.#set(database, key, value)),
            };
            return await runSqliteTransactionBody(
                {
                    close: () => undefined,
                    commit: async () => {
                        await database.execute("COMMIT");
                    },
                    rollback: async () => {
                        await database.execute("ROLLBACK");
                    },
                },
                async () => {
                    try {
                        return await operation(transaction);
                    } finally {
                        active = false;
                    }
                },
            );
        });
    }

    async close(): Promise<void> {
        if (this.#lifecycle === "closed") return;
        if (this.#closePromise !== undefined) return await this.#closePromise;

        // Mark closing before queueing the lock holder. Calls arriving after this point reject;
        // work admitted while the lifecycle was open is already ahead of this close operation.
        this.#lifecycle = "closing";
        this.#closePromise = withWorkerContext("murmur-store-close", (ctx) =>
            ctx.span("rig.sql.sharing.murmur.close", () =>
                this.#lock.runInLock(ctx, async () => {
                    try {
                        await this.#ready.catch(() => undefined);
                        await this.#client.close();
                    } finally {
                        this.#lifecycle = "closed";
                    }
                }),
            ),
        );
        await this.#closePromise;
    }

    async #initialize(ctx: Context, path: string): Promise<void> {
        await ctx.span("rig.sql.sharing.murmur.initialize", async () => {
            if (path !== ":memory:") {
                await mkdir(dirname(path), { mode: 0o700, recursive: true });
            }
            await this.#client.execute(`
            CREATE TABLE IF NOT EXISTS murmur_store (
                key TEXT NOT NULL PRIMARY KEY COLLATE BINARY,
                value BLOB NOT NULL
            )
        `);
            if (path !== ":memory:") await chmod(path, 0o600);
        });
    }

    async #get(database: SqlExecutor, key: string): Promise<Uint8Array | undefined> {
        const result = await database.execute({
            sql: "SELECT value FROM murmur_store WHERE key = ?",
            args: [key],
        });
        const row = result.rows[0] as unknown as Pick<MurmurStoreRow, "value"> | undefined;
        return row === undefined ? undefined : toUint8Array(row.value);
    }

    async #set(database: SqlExecutor, key: string, value: Uint8Array): Promise<void> {
        await database.execute({
            sql: `INSERT INTO murmur_store (key, value) VALUES (?, ?)
                  ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
            args: [key, value],
        });
    }

    async #delete(database: SqlExecutor, key: string): Promise<void> {
        await database.execute({
            sql: "DELETE FROM murmur_store WHERE key = ?",
            args: [key],
        });
    }

    async #scan(
        database: SqlExecutor,
        prefix: string,
        options: StoreScanOptions,
    ): Promise<ReadonlyMap<string, Uint8Array>> {
        if (
            !Number.isSafeInteger(options.limit) ||
            options.limit < 1 ||
            options.limit > MAXIMUM_STORE_SCAN_ITEMS
        ) {
            throw new Error("Invalid Murmur store scan limit");
        }
        const after = options.after ?? null;
        const result = await database.execute({
            sql: `SELECT key, value
                  FROM murmur_store
                  WHERE substr(key, 1, ?) = ?
                    AND (? IS NULL OR key > ? COLLATE BINARY)
                  ORDER BY key COLLATE BINARY
                  LIMIT ?`,
            args: [prefix.length, prefix, after, after, options.limit],
        });
        const rows = result.rows as unknown as MurmurStoreRow[];
        return new Map(rows.map((row) => [row.key, toUint8Array(row.value)]));
    }

    #run<Result>(operation: (database: Client) => Promise<Result>): Promise<Result> {
        if (this.#lifecycle !== "open") return Promise.reject(new Error("Murmur store is closed"));
        return withWorkerContext("murmur-store-operation", (ctx) =>
            this.#lock.runInLock(ctx, async () => {
                await this.#ready;
                return await operation(this.#client);
            }),
        );
    }
}

function toUint8Array(value: ArrayBuffer | Uint8Array): Uint8Array {
    return new Uint8Array(value);
}

function createMurmurClient(path: string): Client {
    if (path === ":memory:") {
        return createHeldMemorySqliteClient("rig-murmur-memory");
    }
    return createClient({
        intMode: "number",
        timeout: 5_000,
        url: pathToFileURL(path).href,
    });
}
