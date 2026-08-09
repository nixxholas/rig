import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import {
    MAXIMUM_STORE_SCAN_ITEMS,
    type MurmurStore,
    type StoreScanOptions,
    type StoreTransaction,
} from "@slopus/murmur";
import Database from "better-sqlite3";

interface MurmurStoreRow {
    key: string;
    value: Buffer;
}

export class SqliteMurmurStore implements MurmurStore {
    readonly #client: Database.Database;
    #closed = false;
    #tail: Promise<void> = Promise.resolve();

    constructor(path: string) {
        if (path !== ":memory:") mkdirSync(dirname(path), { mode: 0o700, recursive: true });
        this.#client = new Database(path, { timeout: 5_000 });
        this.#client.pragma("journal_mode = WAL");
        this.#client.pragma("synchronous = FULL");
        this.#client.exec(`
            CREATE TABLE IF NOT EXISTS murmur_store (
                key TEXT NOT NULL PRIMARY KEY COLLATE BINARY,
                value BLOB NOT NULL
            )
        `);
        if (path !== ":memory:") chmodSync(path, 0o600);
    }

    get(key: string): Promise<Uint8Array | undefined> {
        return this.#run(() => this.#get(key));
    }

    set(key: string, value: Uint8Array): Promise<void> {
        return this.#run(() => this.#set(key, value));
    }

    delete(key: string): Promise<void> {
        return this.#run(() => this.#delete(key));
    }

    list(prefix: string): Promise<ReadonlyMap<string, Uint8Array>> {
        return this.#run(() => this.#scan(prefix, { limit: MAXIMUM_STORE_SCAN_ITEMS }));
    }

    scan(prefix: string, options: StoreScanOptions): Promise<ReadonlyMap<string, Uint8Array>> {
        return this.#run(() => this.#scan(prefix, options));
    }

    transaction<Result>(
        operation: (transaction: StoreTransaction) => Promise<Result>,
    ): Promise<Result> {
        return this.#run(async () => {
            this.#client.exec("BEGIN IMMEDIATE");
            const transaction: StoreTransaction = {
                delete: async (key) => this.#delete(key),
                get: async (key) => this.#get(key),
                list: async (prefix) => this.#scan(prefix, { limit: MAXIMUM_STORE_SCAN_ITEMS }),
                scan: async (prefix, options) => this.#scan(prefix, options),
                set: async (key, value) => this.#set(key, value),
            };
            try {
                const result = await operation(transaction);
                this.#client.exec("COMMIT");
                return result;
            } catch (error) {
                this.#client.exec("ROLLBACK");
                throw error;
            }
        });
    }

    async close(): Promise<void> {
        if (this.#closed) return;
        this.#closed = true;
        await this.#tail;
        this.#client.close();
    }

    #get(key: string): Uint8Array | undefined {
        const row = this.#client
            .prepare("SELECT value FROM murmur_store WHERE key = ?")
            .get(key) as Pick<MurmurStoreRow, "value"> | undefined;
        return row === undefined ? undefined : new Uint8Array(row.value);
    }

    #set(key: string, value: Uint8Array): void {
        this.#client
            .prepare(
                `INSERT INTO murmur_store (key, value) VALUES (?, ?)
                 ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
            )
            .run(key, Buffer.from(value));
    }

    #delete(key: string): void {
        this.#client.prepare("DELETE FROM murmur_store WHERE key = ?").run(key);
    }

    #scan(prefix: string, options: StoreScanOptions): ReadonlyMap<string, Uint8Array> {
        if (
            !Number.isSafeInteger(options.limit) ||
            options.limit < 1 ||
            options.limit > MAXIMUM_STORE_SCAN_ITEMS
        ) {
            throw new Error("Invalid Murmur store scan limit");
        }
        const after = options.after ?? null;
        const rows = this.#client
            .prepare(
                `SELECT key, value
                 FROM murmur_store
                 WHERE substr(key, 1, ?) = ?
                   AND (? IS NULL OR key > ? COLLATE BINARY)
                 ORDER BY key COLLATE BINARY
                 LIMIT ?`,
            )
            .all(prefix.length, prefix, after, after, options.limit) as MurmurStoreRow[];
        return new Map(rows.map((row) => [row.key, new Uint8Array(row.value)]));
    }

    #run<Result>(operation: () => Result | Promise<Result>): Promise<Result> {
        if (this.#closed) return Promise.reject(new Error("Murmur store is closed"));
        const result = this.#tail.then(operation);
        this.#tail = result.then(
            () => undefined,
            () => undefined,
        );
        return result;
    }
}
