import { sql } from "drizzle-orm";

import type { SessionDatabase } from "../openSessionDatabase.js";
import { agentSessionSharing } from "../migrations/18-agent-session-sharing.js";
import { sessionShareEntryLog } from "../migrations/19-session-share-entry-log.js";

/**
 * Removes the schema that migrations after the data-identity ones create.
 *
 * A test that rewinds `user_version` to replay an identity migration replays
 * every later migration with it, so that later schema has to go too; a real
 * database at that schema version never has it. Without this, a replayed
 * `CREATE TABLE` or `ADD COLUMN` meets its own output and the rewind fails.
 */
export function dropSchemaAddedAfterIdentityMigrations(database: SessionDatabase): void {
    for (const table of database.all<{ name: string }>(
        sql.raw(
            `SELECT name FROM sqlite_master
             WHERE type = 'table'
               AND (
                   name LIKE 'happy_cloud_%'
                   OR name LIKE 'scope_share%'
                   OR name LIKE 'worklet%'
                   OR name IN ('folders', 'p2p_peer_pairings', 'p2p_peers', 'rig_profiles')
               )`,
        ),
    )) {
        database.run(sql.raw(`DROP TABLE "${table.name}"`));
    }
    database.run(sql.raw("DROP INDEX IF EXISTS sessions_unsorted"));
    database.run(sql.raw("ALTER TABLE sessions DROP COLUMN unsorted_since_ms"));
    database.run(sql.raw("DROP INDEX IF EXISTS sessions_folder"));
    database.run(sql.raw("ALTER TABLE sessions DROP COLUMN folder_id"));
    database.run(sql.raw("ALTER TABLE project_workspaces ADD COLUMN title TEXT"));
    database.run(sql.raw("ALTER TABLE project_workspaces DROP COLUMN name_configured"));
    database.run(sql.raw("ALTER TABLE project_workspaces DROP COLUMN branch"));
    agentSessionSharing(database);
    sessionShareEntryLog(database);
}
