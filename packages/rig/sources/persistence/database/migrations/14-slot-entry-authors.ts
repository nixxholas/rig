import { sql } from "drizzle-orm";

import type { SessionDatabase } from "../openSessionDatabase.js";

/** Represents slot authors as typed agents or plugins while preserving every existing agent row. */
export function slotEntryAuthors(database: SessionDatabase): void {
    database.run(sql.raw("ALTER TABLE slot_entries RENAME TO slot_entries_agent_authors"));
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
            author_type TEXT NOT NULL,
            author_id TEXT NOT NULL,
            author_name TEXT,
            description TEXT NOT NULL,
            purpose TEXT NOT NULL,
            created_at_ms INTEGER NOT NULL,
            updated_at_ms INTEGER NOT NULL
        )
    `),
    );
    database.run(
        sql.raw(`
        INSERT INTO slot_entries (
            id,
            slot,
            scope,
            project_id,
            workspace_id,
            session_id,
            content_json,
            author_type,
            author_id,
            author_name,
            description,
            purpose,
            created_at_ms,
            updated_at_ms
        )
        SELECT
            id,
            slot,
            scope,
            project_id,
            workspace_id,
            session_id,
            content_json,
            'agent',
            author_session_id,
            NULL,
            description,
            purpose,
            created_at_ms,
            updated_at_ms
        FROM slot_entries_agent_authors
    `),
    );
    database.run(sql.raw("DROP TABLE slot_entries_agent_authors"));
}