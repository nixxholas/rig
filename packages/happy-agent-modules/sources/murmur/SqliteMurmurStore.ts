import { agentDatabaseRows, agentDatabaseRun } from "@slopus/happy-agent-base";
import {
    MAXIMUM_STORE_SCAN_ITEMS,
    type MurmurStore,
    type StoreScanOptions,
    type StoreTransaction,
} from "@slopus/murmur";
import { sql } from "drizzle-orm";
import type { Context, RootContext } from "@steve.kite/stdlib";

import { MURMUR_STORE_TABLE } from "./MurmurDatabase.js";

interface MurmurStoreRow {
    readonly key: string;
    readonly value_base64: string;
}

/**
 * Murmur's own durable state, in the agent database alongside everything else this agent knows.
 *
 * Murmur has no caller context in its store API, so the store is given the lifetime it belongs to
 * and every statement runs on that. It outlives each request that happens to reach it, which is
 * why it may not borrow one.
 *
 * Values are base64 text rather than blobs: the same statements then work on either database this
 * package supports, and every other module table already keeps its payload as text.
 */
export class SqliteMurmurStore implements MurmurStore {
    readonly #ctx: Context;
    #closed = false;

    constructor(lifetime: RootContext) {
        this.#ctx = lifetime.named("murmur-store");
    }

    async get(key: string): Promise<Uint8Array | undefined> {
        this.#requireOpen();
        return await this.#read(this.#ctx, key);
    }

    async set(key: string, value: Uint8Array): Promise<void> {
        this.#requireOpen();
        await this.#write(this.#ctx, key, value);
    }

    async delete(key: string): Promise<void> {
        this.#requireOpen();
        await this.#remove(this.#ctx, key);
    }

    async list(prefix: string): Promise<ReadonlyMap<string, Uint8Array>> {
        return await this.scan(prefix, { limit: MAXIMUM_STORE_SCAN_ITEMS });
    }

    async scan(
        prefix: string,
        options: StoreScanOptions,
    ): Promise<ReadonlyMap<string, Uint8Array>> {
        this.#requireOpen();
        return await this.#page(this.#ctx, prefix, options);
    }

    /**
     * One Murmur transaction, on the agent database's transaction.
     *
     * Murmur expects to read its own uncommitted writes and to lose all of them together when the
     * body throws, which is what the surrounding agent transaction already provides.
     */
    async transaction<Result>(
        operation: (transaction: StoreTransaction) => Promise<Result>,
    ): Promise<Result> {
        this.#requireOpen();
        return await this.#ctx.inTx(async (txCtx) => {
            let active = true;
            const inTransaction = <Value>(work: () => Promise<Value>): Promise<Value> =>
                active ? work() : Promise.reject(new Error("Murmur transaction is closed"));
            const transaction: StoreTransaction = {
                delete: (key) => inTransaction(() => this.#remove(txCtx, key)),
                get: (key) => inTransaction(() => this.#read(txCtx, key)),
                list: (prefix) =>
                    inTransaction(() =>
                        this.#page(txCtx, prefix, { limit: MAXIMUM_STORE_SCAN_ITEMS }),
                    ),
                scan: (prefix, options) => inTransaction(() => this.#page(txCtx, prefix, options)),
                set: (key, value) => inTransaction(() => this.#write(txCtx, key, value)),
            };
            try {
                return await operation(transaction);
            } finally {
                active = false;
            }
        });
    }

    /**
     * Stops accepting work.
     *
     * The database belongs to the agent, so there is no connection to give back here; closing only
     * means that a client shutting down cannot keep writing through a store nobody owns any more.
     */
    async close(): Promise<void> {
        this.#closed = true;
    }

    async #read(ctx: Context, key: string): Promise<Uint8Array | undefined> {
        const rows = await agentDatabaseRows<Pick<MurmurStoreRow, "value_base64">>(
            ctx.db,
            sql`SELECT value_base64 FROM ${sql.raw(MURMUR_STORE_TABLE)} WHERE key = ${key}`,
        );
        const row = rows[0];
        return row === undefined ? undefined : decodeValue(row.value_base64);
    }

    async #write(ctx: Context, key: string, value: Uint8Array): Promise<void> {
        await agentDatabaseRun(
            ctx.db,
            sql`INSERT INTO ${sql.raw(MURMUR_STORE_TABLE)} (key, value_base64)
                VALUES (${key}, ${encodeValue(value)})
                ON CONFLICT (key) DO UPDATE SET value_base64 = EXCLUDED.value_base64`,
        );
    }

    async #remove(ctx: Context, key: string): Promise<void> {
        await agentDatabaseRun(
            ctx.db,
            sql`DELETE FROM ${sql.raw(MURMUR_STORE_TABLE)} WHERE key = ${key}`,
        );
    }

    /**
     * One page of keys under a prefix, in byte order.
     *
     * The order only has to be the same one `after` continues from, but it is byte order here
     * because Murmur's keys carry base64url identities, whose case and punctuation a linguistic
     * collation would fold together.
     */
    async #page(
        ctx: Context,
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
        const rows = await agentDatabaseRows<MurmurStoreRow>(
            ctx.db,
            sql`SELECT key, value_base64
                FROM ${sql.raw(MURMUR_STORE_TABLE)}
                WHERE substr(key, 1, ${prefix.length}) = ${prefix}
                  AND (${after} IS NULL OR key > ${after} COLLATE BINARY)
                ORDER BY key COLLATE BINARY
                LIMIT ${options.limit}`,
        );
        return new Map(rows.map((row) => [row.key, decodeValue(row.value_base64)]));
    }

    #requireOpen(): void {
        if (this.#closed) throw new Error("Murmur store is closed");
    }
}

function encodeValue(value: Uint8Array): string {
    return Buffer.from(value).toString("base64");
}

function decodeValue(value: string): Uint8Array {
    return new Uint8Array(Buffer.from(value, "base64"));
}
