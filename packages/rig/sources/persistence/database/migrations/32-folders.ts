import { sql } from "drizzle-orm";

import type { DrizzleSessionTx as SessionDatabase } from "../SessionDatabase.js";

/**
 * The folder tree.
 *
 * Folders are nested only virtually: `parent_id` places a folder in the tree while `path` is a flat
 * storage directory named after the folder's own id, so a move rewrites rows and never the disk.
 * Sessions gain the folder they were filed into; a session without one sits in Unsorted.
 */
export async function folders(database: SessionDatabase): Promise<void> {
    await database.run(
        sql.raw(`
        CREATE TABLE folders (
            id TEXT NOT NULL PRIMARY KEY,
            parent_id TEXT REFERENCES folders(id),
            name TEXT NOT NULL,
            description TEXT,
            rules TEXT,
            icon TEXT,
            order_key TEXT NOT NULL,
            path TEXT NOT NULL UNIQUE,
            version INTEGER NOT NULL,
            created_at_ms INTEGER NOT NULL,
            updated_at_ms INTEGER NOT NULL,
            archived_at_ms INTEGER
        )
    `),
    );
    await database.run(
        sql.raw("CREATE INDEX folders_parent_order ON folders (parent_id, order_key)"),
    );
    const sessions = (
        await database.all<{ name: string }>(
            sql.raw("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sessions'"),
        )
    )[0];
    if (sessions === undefined) return;
    await database.run(
        sql.raw("ALTER TABLE sessions ADD COLUMN folder_id TEXT REFERENCES folders(id)"),
    );
    await database.run(
        sql.raw("CREATE INDEX sessions_folder ON sessions (folder_id, updated_at_ms DESC)"),
    );
}
