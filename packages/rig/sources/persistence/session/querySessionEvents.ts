import { sql } from "drizzle-orm";

import type { SessionEvent } from "../../protocol/index.js";
import type { TX } from "../Transaction.js";
import { readSessionEventRow } from "./impl/sessionEventRow.js";

export function querySessionEvents(tx: TX, sessionId: string, limit?: number): SessionEvent[] {
    const rows =
        limit === undefined
            ? tx.all<Record<string, unknown>>(sql`
                  SELECT event_id, type, created_at_ms, data_json
                  FROM session_events
                  WHERE session_id = ${sessionId}
                  ORDER BY seq ASC
              `)
            : tx.all<Record<string, unknown>>(sql`
                  SELECT event_id, type, created_at_ms, data_json
                  FROM (
                      SELECT seq, event_id, type, created_at_ms, data_json
                      FROM session_events
                      WHERE session_id = ${sessionId}
                      ORDER BY seq DESC
                      LIMIT ${limit}
                  )
                  ORDER BY seq ASC
              `);
    return rows.map((row) => readSessionEventRow(row, sessionId));
}
