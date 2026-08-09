import { createClient, type Client } from "@libsql/client";
import { _createClient as createSqliteClient } from "@libsql/client/sqlite3";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { sql } from "drizzle-orm";

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
}

/**
 * Opens and configures the local asynchronous SQLite connection.
 *
 * `query_only` is the libSQL equivalent of the old driver's read-only connection option. The
 * inspection path checks that the file exists before calling this function, so enabling it does
 * not create a missing database.
 */
export async function openSessionDatabase(
    path: string,
    options: { readOnly?: boolean } = {},
): Promise<OpenSessionDatabase> {
    const client = createSessionClient(path);
    const database = createSessionDatabase(client);
    try {
        await database.runInLock(async (connection) => {
            if (options.readOnly === true) {
                await connection.run(sql.raw("PRAGMA query_only = ON"));
            } else {
                await connection.run(sql.raw("PRAGMA journal_mode = WAL"));
                await connection.run(sql.raw("PRAGMA synchronous = FULL"));
            }
            await connection.run(sql.raw("PRAGMA foreign_keys = ON"));
        });
        return { client, database };
    } catch (error) {
        await database.close();
        throw error;
    }
}

function sqliteUrl(path: string): string {
    if (path.startsWith("file:")) {
        return path;
    }
    return pathToFileURL(path).href;
}

function createSessionClient(path: string): Client {
    if (path === ":memory:") {
        // The public client rejects mode=memory URLs, while plain :memory: can lose state when
        // libSQL rotates its underlying connection after a transaction. Use a named shared-cache
        // database through the expanded sqlite3 client configuration instead.
        return createSqliteClient({
            scheme: "file",
            path: `file:rig-memory-${randomUUID()}?mode=memory&cache=shared`,
            authority: undefined,
            tls: false,
            intMode: "number",
            concurrency: 1,
        } as Parameters<typeof createSqliteClient>[0]);
    }
    return createClient({
        intMode: "number",
        url: sqliteUrl(path),
        timeout: 5_000,
    });
}

export type SessionDatabaseClient = Client;
