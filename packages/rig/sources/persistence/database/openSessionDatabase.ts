import { createClient, type Client } from "@libsql/client";
import type { Context } from "@steve.kite/stdlib";
import { pathToFileURL } from "node:url";
import { sql } from "drizzle-orm";

import { createHeldMemorySqliteClient } from "./createHeldMemorySqliteClient.js";
import { withDatabase } from "../databaseContext.js";
import { createSessionDatabase, SessionDatabase } from "./SessionDatabase.js";

export {
    SessionDatabase,
    SessionDatabaseClosedError,
    SessionDatabaseTransactionError,
    type DrizzleSessionDatabase,
    type DrizzleSessionTransaction,
    type DrizzleSessionTx,
} from "./SessionDatabase.js";

export interface OpenSessionDatabase {
    readonly client: Client;
    readonly database: SessionDatabase;
    /** Context carrying this database as its active SQL scope. */
    readonly ctx: Context;
}

/**
 * Opens and configures the local asynchronous SQLite connection.
 *
 * `query_only` is the libSQL equivalent of the old driver's read-only connection option. The
 * inspection path checks that the file exists before calling this function, so enabling it does
 * not create a missing database.
 */
export async function openSessionDatabase(
    ctx: Context,
    path: string,
    options: { readOnly?: boolean } = {},
): Promise<OpenSessionDatabase> {
    return await ctx.span("rig.sql.database.open", async (ctx) => {
        const client = createSessionClient(path);
        const database = createSessionDatabase(client);
        try {
            await database.runInLock(ctx, async (_ctx, connection) => {
                if (options.readOnly === true) {
                    await connection.run(sql.raw("PRAGMA query_only = ON"));
                } else {
                    await connection.run(sql.raw("PRAGMA journal_mode = WAL"));
                    await connection.run(sql.raw("PRAGMA synchronous = FULL"));
                }
                await connection.run(sql.raw("PRAGMA foreign_keys = ON"));
            });
            return { client, database, ctx: withDatabase(ctx, database) };
        } catch (error) {
            await database.close(ctx);
            throw error;
        }
    });
}

function sqliteUrl(path: string): string {
    if (path.startsWith("file:")) {
        return path;
    }
    return pathToFileURL(path).href;
}

function createSessionClient(path: string): Client {
    if (path === ":memory:") {
        return createHeldMemorySqliteClient("rig-memory");
    }
    return createClient({
        intMode: "number",
        url: sqliteUrl(path),
        timeout: 5_000,
    });
}

export type SessionDatabaseClient = Client;
