import { sql } from "drizzle-orm";
import type { Context } from "@steve.kite/stdlib";

import {
    agentDatabaseRows,
    agentDatabaseRun,
    type AgentDatabase,
    type AgentDatabaseFacade,
    type AgentStorageTransaction,
} from "./AgentDatabase.js";
import { agentStorageTransaction } from "./AgentContexts.js";
import type { AgentPersistence, AgentRecord } from "./AgentPersistence.js";

/** The database and transaction integration shared by every scope in one AgentStorage. */
export interface AgentPersistenceDrizzleOptions<Database extends AgentDatabase = AgentDatabase> {
    readonly database: Database;
    readonly owner: object;
    readonly transaction: AgentStorageTransaction<Database>;
}

/**
 * Drizzle-backed records and key-value entries for either the collection root or one agent.
 * Tables are shared by every instance; `ownerId` is empty for collection state and the cuid2
 * agent identity for a conversation.
 */
export class AgentPersistenceDrizzle<
    Database extends AgentDatabase = AgentDatabase,
> implements AgentPersistence {
    readonly #options: AgentPersistenceDrizzleOptions<Database>;
    readonly #ownerId: string;

    constructor(options: AgentPersistenceDrizzleOptions<Database>, ownerId: string) {
        this.#options = options;
        this.#ownerId = ownerId;
    }

    get database(): AgentDatabase {
        return this.#options.database;
    }

    async transaction<Result>(
        ctx: Context,
        work: (ctx: Context) => Promise<Result>,
    ): Promise<Result> {
        return await this.#options.transaction(ctx, async (txCtx) => await work(txCtx));
    }

    async load(ctx: Context): Promise<readonly AgentRecord[]> {
        return await this.#operation(ctx, async (database) => {
            const rows = await agentDatabaseRows<{ record_json: string }>(
                database,
                sql`SELECT record_json
                    FROM happy_agent_records
                    WHERE owner_id = ${this.#ownerId}
                    ORDER BY position`,
            );
            return rows.map(({ record_json }) => JSON.parse(record_json) as AgentRecord);
        });
    }

    async append(ctx: Context, record: AgentRecord): Promise<void> {
        await this.#operation(ctx, async (database) => {
            await agentDatabaseRun(
                database,
                sql`INSERT INTO happy_agent_records (owner_id, position, record_json)
                    SELECT ${this.#ownerId}, COALESCE(MAX(position), -1) + 1, ${JSON.stringify(record)}
                    FROM happy_agent_records
                    WHERE owner_id = ${this.#ownerId}`,
            );
        });
    }

    async clearRecords(ctx: Context): Promise<void> {
        await this.#operation(ctx, async (database) => {
            await agentDatabaseRun(
                database,
                sql`DELETE FROM happy_agent_records WHERE owner_id = ${this.#ownerId}`,
            );
        });
    }

    async readValues(
        ctx: Context,
        prefix: string,
    ): Promise<readonly { readonly key: string; readonly value: unknown }[]> {
        return await this.#operation(ctx, async (database) => {
            const rows = await agentDatabaseRows<{ key: string; value_json: string }>(
                database,
                sql`SELECT key, value_json
                    FROM happy_agent_values
                    WHERE owner_id = ${this.#ownerId}
                      AND substr(key, 1, length(${prefix})) = ${prefix}
                    ORDER BY key`,
            );
            return rows.map(({ key, value_json }) => ({ key, value: JSON.parse(value_json) }));
        });
    }

    async writeValue(ctx: Context, key: string, value: unknown): Promise<void> {
        const encoded = JSON.stringify(value);
        if (encoded === undefined) throw new Error("Agent storage cannot persist undefined.");
        await this.#operation(ctx, async (database) => {
            await agentDatabaseRun(
                database,
                sql`INSERT INTO happy_agent_values (owner_id, key, value_json)
                    VALUES (${this.#ownerId}, ${key}, ${encoded})
                    ON CONFLICT (owner_id, key)
                    DO UPDATE SET value_json = EXCLUDED.value_json`,
            );
        });
    }

    async writeValueIfAbsent(ctx: Context, key: string, value: unknown): Promise<boolean> {
        const encoded = JSON.stringify(value);
        if (encoded === undefined) throw new Error("Agent storage cannot persist undefined.");
        return await this.#operation(ctx, async (database) => {
            const rows = await agentDatabaseRows<{ key: string }>(
                database,
                sql`INSERT INTO happy_agent_values (owner_id, key, value_json)
                    VALUES (${this.#ownerId}, ${key}, ${encoded})
                    ON CONFLICT (owner_id, key) DO NOTHING
                    RETURNING key`,
            );
            return rows.length > 0;
        });
    }

    async deleteValue(ctx: Context, key: string): Promise<void> {
        await this.#operation(ctx, async (database) => {
            await agentDatabaseRun(
                database,
                sql`DELETE FROM happy_agent_values
                    WHERE owner_id = ${this.#ownerId} AND key = ${key}`,
            );
        });
    }

    async #operation<Result>(
        ctx: Context,
        work: (database: AgentDatabaseFacade<Database>) => Promise<Result>,
    ): Promise<Result> {
        const transaction = agentStorageTransaction(ctx);
        if (transaction !== undefined) {
            if (transaction.lifetime.aborted) {
                throw new Error("The agent storage transaction carried by this context has ended.");
            }
            if (transaction.owner !== this.#options.owner) {
                throw new Error("A transaction context cannot be used with another agent storage.");
            }
            return await work(transaction.database as AgentDatabaseFacade<Database>);
        }
        return await this.#options.transaction(ctx, async (_txCtx, database) => {
            return await work(database);
        });
    }
}
