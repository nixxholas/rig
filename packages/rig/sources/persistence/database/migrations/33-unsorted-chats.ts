import { sql } from "drizzle-orm";

import type { SessionDatabase } from "../openSessionDatabase.js";

/**
 * When a chat started out belonging nowhere.
 *
 * A chat with no folder is not automatically Unsorted: every chat that exists today has no folder
 * because folders are new, and none of them should be put away. Unsorted is the state a chat is
 * created in when it is started from the folder tree without one, and this column is the moment
 * that happened. Filing the chat into a folder clears it, so only a chat that is still waiting to
 * be sorted can run out of time.
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
