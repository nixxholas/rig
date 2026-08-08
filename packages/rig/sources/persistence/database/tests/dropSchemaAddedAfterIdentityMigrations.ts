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
    dropSessionScopeSchema(database);
    for (const table of database.all<{ name: string }>(
        sql.raw(
            `SELECT name FROM sqlite_master
             WHERE type = 'table'
               AND (
                   name LIKE 'happy_cloud_%'
                   OR name LIKE 'scope_share%'
                   OR name LIKE 'worklet%'
                   OR name IN ('folder_catalog', 'folder_mutations', 'folders', 'p2p_peer_pairings', 'p2p_peers', 'rig_profiles', 'session_mutations')
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

/** Rebuilds migration 36's checked table into the migration 35 shape before older rewinds. */
export function dropSessionScopeSchema(database: SessionDatabase): void {
    const stored = database.get<{ sql: string }>(
        sql.raw("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'sessions'"),
    );
    if (stored === undefined || !stored.sql.includes("scope_kind")) return;
    const checkStart = stored.sql.lastIndexOf(",\n            CHECK (");
    if (checkStart === -1) throw new Error("The scoped session check was not found.");
    const definition = `${stored.sql
        .slice(0, checkStart)
        .replace(/^CREATE TABLE\s+"?sessions"?/u, "CREATE TABLE sessions_before_scope")
        .replace(/\n\s*scope_kind TEXT NOT NULL DEFAULT 'project',/u, "")
        .replace(
            "project_id TEXT REFERENCES projects(id)",
            "project_id TEXT NOT NULL REFERENCES projects(id)",
        )}\n        )`;
    const columns = database
        .all<{ name: string }>(sql.raw("PRAGMA table_info(sessions)"))
        .map((column) => column.name)
        .filter((name) => name !== "scope_kind");
    const selected = columns.map((name) => `"${name.replaceAll('"', '""')}"`).join(", ");
    database.run(sql.raw("PRAGMA foreign_keys = OFF"));
    try {
        database.run(sql.raw(definition));
        database.run(
            sql.raw(
                `INSERT INTO sessions_before_scope (${selected}) SELECT ${selected} FROM sessions`,
            ),
        );
        database.run(sql.raw("DROP TABLE sessions"));
        database.run(sql.raw("ALTER TABLE sessions_before_scope RENAME TO sessions"));
    } finally {
        database.run(sql.raw("PRAGMA foreign_keys = ON"));
    }
}
