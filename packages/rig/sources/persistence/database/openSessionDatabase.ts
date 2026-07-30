import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";

import * as schema from "./schema.js";

export type SessionDatabase = BetterSQLite3Database<typeof schema>;

export interface OpenSessionDatabase {
    client: Database.Database;
    database: SessionDatabase;
}

export function openSessionDatabase(
    path: string,
    options: { readOnly?: boolean } = {},
): OpenSessionDatabase {
    const client = new Database(path, {
        readonly: options.readOnly ?? false,
        timeout: 5_000,
    });
    if (options.readOnly !== true) {
        client.pragma("journal_mode = WAL");
        client.pragma("synchronous = FULL");
    }
    client.pragma("foreign_keys = ON");
    const database = drizzle(client, { schema });
    return { client, database };
}
