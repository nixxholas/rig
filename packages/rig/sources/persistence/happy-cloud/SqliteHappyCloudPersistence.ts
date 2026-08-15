import type { Context } from "@steve.kite/stdlib";

import type { HappyCloudPersistence } from "../../happy-cloud/HappyCloudService.js";
import { getDatabaseScope, withDatabase } from "../databaseContext.js";
import { isSessionDatabaseTransaction, type SessionDatabase } from "../database/SessionDatabase.js";
import { runSessionTransaction } from "../database/SessionTransactionContext.js";

/**
 * Installs Rig's database on each Happy Cloud operation without retaining a caller context.
 *
 * Happy Cloud owns its commands; this adapter owns only the SQLite execution boundary they use.
 */
export class SqliteHappyCloudPersistence implements HappyCloudPersistence {
    readonly #database: SessionDatabase;

    constructor(database: SessionDatabase) {
        this.#database = database;
    }

    async query<T>(ctx: Context, operation: (ctx: Context) => Promise<T>): Promise<T> {
        this.#assertOpen();
        return await operation(withDatabase(ctx, this.#database));
    }

    async transaction<T>(ctx: Context, operation: (ctx: Context) => Promise<T>): Promise<T> {
        this.#assertOpen();
        ctx = withDatabase(ctx, this.#database);
        if (isSessionDatabaseTransaction(getDatabaseScope(ctx))) return await operation(ctx);
        return await runSessionTransaction(ctx, operation);
    }

    #assertOpen(): void {
        if (!this.#database.closed) return;
        throw new Error("The Rig database is closed.");
    }
}
