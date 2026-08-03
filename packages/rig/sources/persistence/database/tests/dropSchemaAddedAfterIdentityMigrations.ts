import { sql } from "drizzle-orm";

import type { SessionDatabase } from "../openSessionDatabase.js";

/**
 * Removes the tables that migrations after the data-identity ones create.
 *
 * A test that rewinds `user_version` to replay an identity migration replays
 * every later migration with it, so those later tables have to go too; a real
 * database at that schema version never has them. Without this, a replayed
 * `CREATE TABLE` meets its own output and the rewind fails.
 */
export function dropSchemaAddedAfterIdentityMigrations(database: SessionDatabase): void {
    for (const table of database.all<{ name: string }>(
        sql.raw(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'happy_cloud_%'",
        ),
    )) {
        database.run(sql.raw(`DROP TABLE "${table.name}"`));
    }
}
