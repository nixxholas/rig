import { chmodSync, closeSync, lstatSync, openSync, unlinkSync } from "node:fs";

import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { MurmurStore, StoreTransaction } from "@slopus/murmur";
import Database from "better-sqlite3";

const MAXIMUM_KEY_CHARACTERS = 4_096;
const MAXIMUM_VALUE_BYTES = 64 * 1024 * 1024;
const exact = { additionalProperties: false } as const;

const databasePathSchema = Type.String({ minLength: 1 });
const keySchema = Type.String({ maxLength: MAXIMUM_KEY_CHARACTERS, minLength: 1 });
const prefixSchema = Type.String({ maxLength: MAXIMUM_KEY_CHARACTERS });
const valueSchema = Type.Uint8Array({ maxByteLength: MAXIMUM_VALUE_BYTES });
const storedValueRowSchema = Type.Object({ value: valueSchema }, exact);
const storedKeyValueRowSchema = Type.Object({ key: keySchema, value: valueSchema }, exact);
const fileSystemErrorSchema = Type.Object(
    { code: Type.Optional(Type.String()) },
    { additionalProperties: true },
);

type StoredValueRow = Static<typeof storedValueRowSchema>;
type StoredKeyValueRow = Static<typeof storedKeyValueRowSchema>;

/** Durable, serialized SQLite storage for one local Murmur account. */
export class SqliteMurmurStore implements MurmurStore {
    readonly #database: Database.Database;
    readonly #databasePath: string | undefined;
    #closed = false;
    #tail: Promise<void> = Promise.resolve();

    constructor(path: string) {
        if (!Value.Check(databasePathSchema, path)) {
            throw new Error("Murmur SQLite path cannot be empty");
        }

        this.#databasePath = path === ":memory:" ? undefined : path;
        this.#secureDatabaseFiles(true);
        this.#database = new Database(path, { timeout: 5_000 });
        this.#database.pragma("foreign_keys = ON");
        if (this.#databasePath !== undefined) {
            this.#database.pragma("journal_mode = WAL");
            this.#database.pragma("synchronous = FULL");
        }
        this.#database.exec(`
            CREATE TABLE IF NOT EXISTS murmur_key_values (
                key TEXT PRIMARY KEY,
                value BLOB NOT NULL
            )
        `);
        this.#secureDatabaseFiles();
    }

    async get(key: string): Promise<Uint8Array | undefined> {
        return this.#exclusive(async () => this.#get(key));
    }

    async set(key: string, value: Uint8Array): Promise<void> {
        await this.#exclusive(async () => this.#set(key, value));
    }

    async delete(key: string): Promise<void> {
        await this.#exclusive(async () => this.#delete(key));
    }

    async list(prefix: string): Promise<ReadonlyMap<string, Uint8Array>> {
        return this.#exclusive(async () => this.#list(prefix));
    }

    async transaction<Result>(
        operation: (transaction: StoreTransaction) => Promise<Result>,
    ): Promise<Result> {
        return this.#exclusive(async () => {
            this.#ensureOpen();
            this.#database.exec("BEGIN IMMEDIATE");
            const transaction: StoreTransaction = {
                get: async (key): Promise<Uint8Array | undefined> => this.#get(key),
                set: async (key, value): Promise<void> => this.#set(key, value),
                delete: async (key): Promise<void> => this.#delete(key),
                list: async (prefix): Promise<ReadonlyMap<string, Uint8Array>> =>
                    this.#list(prefix),
            };

            try {
                const result = await operation(transaction);
                this.#database.exec("COMMIT");
                this.#secureDatabaseFiles();
                return result;
            } catch (error: unknown) {
                if (this.#database.inTransaction) {
                    this.#database.exec("ROLLBACK");
                }
                throw error;
            }
        });
    }

    /** Closes the connection after all previously queued store work completes. */
    async close(): Promise<void> {
        await this.#exclusive(async () => {
            if (this.#closed) {
                return;
            }

            this.#database.close();
            this.#closed = true;
            this.#secureDatabaseFiles();
        });
    }

    /**
     * Removes every SQLite file containing Murmur account state after `close()`.
     *
     * The operation is intentionally idempotent so an interrupted account
     * deletion can safely be retried.
     */
    async deleteDatabaseFiles(): Promise<void> {
        if (!this.#closed) {
            throw new Error("Close the Murmur SQLite store before deleting its database files");
        }

        await this.#exclusive(async () => {
            for (const path of this.#databaseFilePaths()) {
                this.#deletePrivateDatabaseFile(path);
            }
        });
    }

    #get(key: string): Uint8Array | undefined {
        this.#ensureOpen();
        this.#validateKey(key);
        const row = this.#database
            .prepare<[string], StoredValueRow>("SELECT value FROM murmur_key_values WHERE key = ?")
            .get(key);
        if (row === undefined) {
            return undefined;
        }
        if (!Value.Check(storedValueRowSchema, row)) {
            throw new Error("Invalid Murmur SQLite value row");
        }
        return Uint8Array.from(row.value);
    }

    #set(key: string, value: Uint8Array): void {
        this.#ensureOpen();
        this.#validateKey(key);
        this.#validateValue(value);
        this.#database
            .prepare<[string, Uint8Array]>(
                `INSERT INTO murmur_key_values(key, value) VALUES (?, ?)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
            )
            .run(key, Uint8Array.from(value));
        this.#secureDatabaseFiles();
    }

    #delete(key: string): void {
        this.#ensureOpen();
        this.#validateKey(key);
        this.#database.prepare<[string]>("DELETE FROM murmur_key_values WHERE key = ?").run(key);
    }

    #list(prefix: string): ReadonlyMap<string, Uint8Array> {
        this.#ensureOpen();
        if (!Value.Check(prefixSchema, prefix)) {
            throw new Error("Invalid Murmur SQLite key prefix");
        }
        const rows = this.#database
            .prepare<[number, string], StoredKeyValueRow>(
                `SELECT key, value FROM murmur_key_values
                 WHERE substr(key, 1, ?) = ?
                 ORDER BY key`,
            )
            .all(prefix.length, prefix);
        const values = new Map<string, Uint8Array>();
        for (const row of rows) {
            if (!Value.Check(storedKeyValueRowSchema, row)) {
                throw new Error("Invalid Murmur SQLite key-value row");
            }
            values.set(row.key, Uint8Array.from(row.value));
        }
        return values;
    }

    #validateKey(key: string): void {
        if (!Value.Check(keySchema, key)) {
            throw new Error("Invalid Murmur SQLite key");
        }
    }

    #validateValue(value: Uint8Array): void {
        if (!Value.Check(valueSchema, value)) {
            throw new Error("Invalid Murmur SQLite value");
        }
    }

    #ensureOpen(): void {
        if (this.#closed) {
            throw new Error("Murmur SQLite store is closed");
        }
    }

    #databaseFilePaths(): readonly string[] {
        return this.#databasePath === undefined
            ? []
            : [this.#databasePath, `${this.#databasePath}-wal`, `${this.#databasePath}-shm`];
    }

    #secureDatabaseFiles(create = false): void {
        if (this.#databasePath === undefined) {
            return;
        }
        if (create && this.#privateRegularFile(this.#databasePath) === undefined) {
            closeSync(openSync(this.#databasePath, "wx", 0o600));
        }
        for (const path of this.#databaseFilePaths()) {
            const statistics = this.#privateRegularFile(path);
            if (statistics === undefined) {
                continue;
            }
            chmodSync(path, 0o600);
            if ((lstatSync(path).mode & 0o077) !== 0) {
                throw new Error("Murmur SQLite state permissions are not private");
            }
        }
    }

    #deletePrivateDatabaseFile(path: string): void {
        if (this.#privateRegularFile(path) !== undefined) {
            unlinkSync(path);
        }
    }

    #privateRegularFile(path: string): ReturnType<typeof lstatSync> | undefined {
        let statistics: ReturnType<typeof lstatSync>;
        try {
            statistics = lstatSync(path);
        } catch (error: unknown) {
            if (Value.Check(fileSystemErrorSchema, error) && error.code === "ENOENT") {
                return undefined;
            }
            throw error;
        }
        if (!statistics.isFile() || statistics.isSymbolicLink()) {
            throw new Error("Murmur SQLite state must use regular private files");
        }
        return statistics;
    }

    async #exclusive<Result>(operation: () => Promise<Result>): Promise<Result> {
        let release: (() => void) | undefined;
        const preceding = this.#tail;
        this.#tail = new Promise<void>((resolve) => {
            release = resolve;
        });
        await preceding;
        try {
            return await operation();
        } finally {
            release?.();
        }
    }
}
