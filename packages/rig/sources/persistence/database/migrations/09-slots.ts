import { sql } from "drizzle-orm";

import type { SessionDatabase } from "../openSessionDatabase.js";

/**
 * Slot entries and webapps.
 *
 * Slot entries are agent-authored content plugged into fixed Happy UI locations. Exactly the
 * scope reference matching the scope is set; an `everywhere` entry sets none of them. The session
 * reference carries no foreign key because the in-memory store holds sessions outside SQLite;
 * session existence is enforced by the slot store inside the writing transaction instead.
 *
 * Webapps are imported source folders served as static files. Each import is a version row and
 * the webapp row names which version is current.
 */
export function slots(database: SessionDatabase): void {
    database.run(
        sql.raw(`
        CREATE TABLE slot_entries (
            id TEXT NOT NULL PRIMARY KEY,
            slot TEXT NOT NULL,
            scope TEXT NOT NULL,
            project_id TEXT REFERENCES projects(id),
            workspace_id TEXT REFERENCES project_workspaces(id),
            session_id TEXT,
            content_json TEXT NOT NULL,
            author_session_id TEXT NOT NULL,
            description TEXT NOT NULL,
            purpose TEXT NOT NULL,
            created_at_ms INTEGER NOT NULL,
            updated_at_ms INTEGER NOT NULL
        )
    `),
    );
    database.run(
        sql.raw(`
        CREATE TABLE webapps (
            name TEXT NOT NULL PRIMARY KEY,
            description TEXT NOT NULL,
            purpose TEXT NOT NULL,
            author_session_id TEXT NOT NULL,
            source_description TEXT,
            current_version INTEGER NOT NULL,
            created_at_ms INTEGER NOT NULL,
            updated_at_ms INTEGER NOT NULL
        )
    `),
    );
    database.run(
        sql.raw(`
        CREATE TABLE webapp_versions (
            webapp_name TEXT NOT NULL REFERENCES webapps(name) ON DELETE CASCADE,
            version INTEGER NOT NULL,
            change_description TEXT NOT NULL,
            created_at_ms INTEGER NOT NULL,
            PRIMARY KEY (webapp_name, version)
        )
    `),
    );
}
