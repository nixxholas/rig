import { inDatabase } from "../database/inDatabase.js";
import { sql } from "drizzle-orm";

import type { SessionEvent } from "../../protocol/index.js";
import type { DatabaseScope } from "../Transaction.js";
import { readSessionEventRow } from "./impl/sessionEventRow.js";

export async function querySessionEvents(
    tx: DatabaseScope,
    sessionId: string,
    limit?: number,
): Promise<SessionEvent[]> {
    return await inDatabase(tx, async (tx) => {
        const rows =
            limit === undefined
                ? await tx.all<Record<string, unknown>>(sql`
                  SELECT event_id, type, created_at_ms, data_json
                  FROM session_events
                  WHERE session_id = ${sessionId}
                  ORDER BY seq ASC
              `)
                : await tx.all<Record<string, unknown>>(sql`
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
    });
}
