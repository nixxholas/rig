import { sql } from "drizzle-orm";

import type { SessionDatabase } from "../openSessionDatabase.js";

/**
 * When a chat started out belonging nowhere.
 *
 * Unsorted is where a chat is born, not merely somewhere a chat without a folder ends up. A chat
 * that belongs to a project or a workspace is sorted by belonging there and is never a candidate,
 * which is every chat that exists today. This column is set only when a chat is started from the
 * folder tree with no folder, and it holds the moment that happened for as long as the chat has
 * none, so filing and unfiling move the chat without rewriting where it came from.
 */
export function unsortedChats(database: SessionDatabase): void {
    const sessions = database.get<{ name: string }>(
        sql.raw("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sessions'"),
    );
    if (sessions === undefined) return;
    database.run(sql.raw("ALTER TABLE sessions ADD COLUMN unsorted_since_ms INTEGER"));
    database.run(
        sql.raw(
            "CREATE INDEX sessions_unsorted ON sessions (unsorted_since_ms) WHERE archived = 0",
        ),
    );
}
