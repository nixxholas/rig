import { sql } from "drizzle-orm";

import type { DrizzleSessionTx as SessionDatabase } from "../SessionDatabase.js";

/**
 * Existing Happy mappings count as backfilled only when a remote mapping or durable outbox row
 * proves that their history passed the old ensure-to-enqueue crash window.
 */
export async function happyHistoryBackfill(database: SessionDatabase): Promise<void> {
    const columns = (
        await database.all<{ name: string }>(sql.raw("PRAGMA table_info(happy_sessions)"))
    ).map((column) => column.name);
    if (columns.length === 0) {
        throw new Error("Cannot migrate Happy history because happy_sessions is missing.");
    }
    if (columns.includes("history_backfilled")) return;
    await database.run(
        sql.raw(
            "ALTER TABLE happy_sessions ADD COLUMN history_backfilled INTEGER NOT NULL DEFAULT 0",
        ),
    );
    await database.run(
        sql.raw(`
            UPDATE happy_sessions
            SET history_backfilled = 1
            WHERE remote_session_id IS NOT NULL
               OR EXISTS (
                    SELECT 1
                    FROM happy_outbox
                    WHERE happy_outbox.session_id = happy_sessions.session_id
               )
        `),
    );
}
