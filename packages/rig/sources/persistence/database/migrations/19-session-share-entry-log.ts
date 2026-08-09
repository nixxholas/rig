import { sql } from "drizzle-orm";

import type { DrizzleSessionTx as SessionDatabase } from "../SessionDatabase.js";

const statements = [
    `CREATE TABLE session_share_entries (
        share_id TEXT NOT NULL REFERENCES session_shares(share_id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL CHECK (sequence >= 1),
        share_event_id TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        canonical_json TEXT NOT NULL,
        byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
        created_at_ms INTEGER NOT NULL,
        PRIMARY KEY (share_id, sequence)
    )`,
] as const;

export async function sessionShareEntryLog(database: SessionDatabase): Promise<void> {
    for (const statement of statements) await database.run(sql.raw(statement));
}
