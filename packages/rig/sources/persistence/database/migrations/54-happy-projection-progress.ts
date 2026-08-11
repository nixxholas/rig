import { sql } from "drizzle-orm";

import type { DrizzleSessionTx as SessionDatabase } from "../SessionDatabase.js";

/** Adds a durable, bounded handoff between Rig events and Happy delivery. */
export async function happyProjectionProgress(database: SessionDatabase): Promise<void> {
    const sessionColumns = (
        await database.all<{ name: string }>(sql.raw("PRAGMA table_info(happy_sessions)"))
    ).map((column) => column.name);
    if (!sessionColumns.includes("projected_event_seq")) {
        await database.run(
            sql.raw("ALTER TABLE happy_sessions ADD COLUMN projected_event_seq INTEGER"),
        );
    }
    if (!sessionColumns.includes("projected_event_id")) {
        await database.run(
            sql.raw("ALTER TABLE happy_sessions ADD COLUMN projected_event_id TEXT"),
        );
    }
    if (!sessionColumns.includes("projection_status")) {
        await database.run(
            sql.raw(
                "ALTER TABLE happy_sessions ADD COLUMN projection_status TEXT NOT NULL DEFAULT 'active' CHECK (projection_status IN ('active', 'stalled'))",
            ),
        );
    }
    if (!sessionColumns.includes("projection_error")) {
        await database.run(sql.raw("ALTER TABLE happy_sessions ADD COLUMN projection_error TEXT"));
    }
    if (!sessionColumns.includes("projection_stall_cause")) {
        await database.run(
            sql.raw(
                "ALTER TABLE happy_sessions ADD COLUMN projection_stall_cause TEXT CHECK (projection_stall_cause IN ('capacity', 'event_too_large', 'gap'))",
            ),
        );
    }

    const outboxColumns = (
        await database.all<{ name: string }>(sql.raw("PRAGMA table_info(happy_outbox)"))
    ).map((column) => column.name);
    if (!outboxColumns.includes("deferred")) {
        await database.run(
            sql.raw(
                "ALTER TABLE happy_outbox ADD COLUMN deferred INTEGER NOT NULL DEFAULT 0 CHECK (deferred IN (0, 1))",
            ),
        );
    }
    await database.run(
        sql.raw(
            "CREATE INDEX IF NOT EXISTS happy_outbox_session_deferred_seq ON happy_outbox(session_id, deferred, seq)",
        ),
    );

    // Version 53 established which legacy sessions already projected their history. Treat the
    // latest durable event as their baseline so upgrading cannot replay acknowledged history.
    const sessionEventsTable = await database.get<{ name: string }>(
        sql.raw("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_events'"),
    );
    if (sessionEventsTable !== undefined) {
        await database.run(
            sql.raw(`
            UPDATE happy_sessions
            SET projected_event_seq = (
                    SELECT MAX(seq) FROM session_events
                    WHERE session_events.session_id = happy_sessions.session_id
                ),
                projected_event_id = (
                    SELECT event_id FROM session_events
                    WHERE session_events.session_id = happy_sessions.session_id
                    ORDER BY seq DESC LIMIT 1
                )
            WHERE history_backfilled = 1
              AND projected_event_seq IS NULL
        `),
        );
    }
}
