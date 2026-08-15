import type { Context } from "@steve.kite/stdlib";

import { inReadTx } from "../inReadTx.js";
import { sql } from "drizzle-orm";

import type { SessionEvent } from "../../protocol/index.js";
import { readSessionEventRow } from "./impl/sessionEventRow.js";
import { readNumber } from "./impl/sqliteRow.js";

export interface SessionEventTailLimit {
    /** Maximum number of exact durable events kept for in-memory resume. */
    maxCount: number;
    /** Maximum encoded row bytes transferred from SQLite for that resume suffix. */
    maxBytes: number;
}

export async function querySessionEvents(
    ctx: Context,
    sessionId: string,
    limit?: SessionEventTailLimit,
): Promise<SessionEvent[]> {
    return await inReadTx(ctx, "rig.sql.session.query_session_events", async (ctx) => {
        const tx = ctx.tx;
        if (limit === undefined) {
            const rows = await tx.all<Record<string, unknown>>(sql`
                  SELECT event_id, type, created_at_ms, data_json
                  FROM session_events
                  WHERE session_id = ${sessionId}
                  ORDER BY seq ASC
              `);
            return rows.map((row) => readSessionEventRow(row, sessionId));
        }

        if (limit.maxBytes <= 0 || limit.maxCount <= 0) return [];

        // Read only row sizes first. Selecting data_json in this pass would make the native
        // driver materialize the legacy snapshots that this bound exists to avoid.
        const candidates = await tx.all<Record<string, unknown>>(sql`
            SELECT seq,
                length(CAST(event_id AS BLOB))
                    + length(CAST(type AS BLOB))
                    + length(CAST(data_json AS BLOB))
                    + 8 AS row_bytes
            FROM session_events
            WHERE session_id = ${sessionId}
            ORDER BY seq DESC
            LIMIT ${limit.maxCount}
        `);
        let retainedBytes = 0;
        let firstRetainedSeq: number | undefined;
        for (const candidate of candidates) {
            const rowBytes = readNumber(candidate, "row_bytes");
            if (retainedBytes + rowBytes > limit.maxBytes) break;
            retainedBytes += rowBytes;
            firstRetainedSeq = readNumber(candidate, "seq");
        }
        if (firstRetainedSeq === undefined) return [];

        const rows = await tx.all<Record<string, unknown>>(sql`
            SELECT event_id, type, created_at_ms, data_json
            FROM session_events
            WHERE session_id = ${sessionId} AND seq >= ${firstRetainedSeq}
            ORDER BY seq ASC
        `);
        return rows.map((row) => readSessionEventRow(row, sessionId));
    });
}
