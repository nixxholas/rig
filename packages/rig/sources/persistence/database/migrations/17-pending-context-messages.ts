import { sql } from "drizzle-orm";

import type { SessionDatabase } from "../openSessionDatabase.js";

export function pendingContextMessages(database: SessionDatabase): void {
    database.run(
        sql.raw(`
        CREATE TABLE pending_context_messages (
            session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
            message_id TEXT NOT NULL,
            position INTEGER NOT NULL,
            anchor_run_id TEXT NOT NULL,
            created_at_ms INTEGER NOT NULL,
            PRIMARY KEY (session_id, message_id),
            UNIQUE (session_id, position)
        )
    `),
    );
    database.run(
        sql.raw(`
        CREATE INDEX pending_context_messages_session_fifo
        ON pending_context_messages (session_id, position)
    `),
    );
}
