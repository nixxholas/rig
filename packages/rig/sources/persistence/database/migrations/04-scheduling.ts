import { sql } from "drizzle-orm";

import type { DrizzleSessionTx as SessionDatabase } from "../SessionDatabase.js";

export async function scheduling(database: SessionDatabase): Promise<void> {
    await database.run(
        sql.raw(`
        CREATE TABLE durable_waits (
            id TEXT NOT NULL PRIMARY KEY,
            session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
            run_id TEXT NOT NULL,
            batch_id TEXT NOT NULL,
            tool_call_id TEXT NOT NULL,
            provider_tool_call_id TEXT,
            tool_call_index INTEGER NOT NULL,
            tool_name TEXT NOT NULL,
            kind TEXT NOT NULL,
            arguments_json TEXT NOT NULL,
            status TEXT NOT NULL,
            consumed INTEGER NOT NULL,
            created_at_ms INTEGER NOT NULL,
            due_at_ms INTEGER NOT NULL,
            result_json TEXT,
            result_block_json TEXT,
            UNIQUE (session_id, tool_call_id)
        )
    `),
    );
    await database.run(
        sql.raw(`
        CREATE INDEX durable_waits_session_created
        ON durable_waits (session_id, created_at_ms)
    `),
    );
    await database.run(
        sql.raw(`
        CREATE TABLE scheduled_messages (
            id TEXT NOT NULL PRIMARY KEY,
            sender_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
            target_agent_id TEXT NOT NULL,
            message TEXT NOT NULL,
            due_at_ms INTEGER NOT NULL,
            status TEXT NOT NULL,
            failure TEXT,
            delivered_at_ms INTEGER,
            created_at_ms INTEGER NOT NULL,
            updated_at_ms INTEGER NOT NULL
        )
    `),
    );
    await database.run(
        sql.raw(`
        CREATE INDEX scheduled_messages_sender_created
        ON scheduled_messages (sender_session_id, created_at_ms)
    `),
    );
    await database.run(
        sql.raw(`
        CREATE INDEX scheduled_messages_pending_due
        ON scheduled_messages (status, due_at_ms)
    `),
    );
}
