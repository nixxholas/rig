import { sql } from "drizzle-orm";

import type { TX } from "../Transaction.js";
import { readString } from "./impl/sqliteRow.js";

export function querySubagentSessionIdsByRoot(tx: TX, rootSessionId: string): readonly string[] {
    return tx
        .all<Record<string, unknown>>(sql`
            SELECT id FROM sessions
            WHERE root_session_id = ${rootSessionId} AND session_kind = 'subagent'
            ORDER BY created_at_ms ASC
        `)
        .map((row) => readString(row, "id"));
}
