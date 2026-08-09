import { sql } from "drizzle-orm";

import type { DrizzleSessionTx as SessionDatabase } from "../SessionDatabase.js";

const statements = [
    // A timeline reads only the handful of lifecycle event types that open and
    // close a span. Without this index, a project timeline scans every event of
    // every chat it covers, and chats are expected to be very long.
    "CREATE INDEX session_events_session_type_seq ON session_events(session_id, type, seq)",
] as const;

export async function timelineIndex(database: SessionDatabase): Promise<void> {
    for (const statement of statements) await database.run(sql.raw(statement));
}
