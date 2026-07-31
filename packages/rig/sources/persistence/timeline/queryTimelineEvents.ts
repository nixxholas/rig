import { sql } from "drizzle-orm";

import type { SessionEvent } from "../../protocol/index.js";
import { TIMELINE_EVENT_TYPES } from "../../timeline/index.js";
import type { TX } from "../Transaction.js";
import { readSessionEventRow } from "../session/impl/sessionEventRow.js";
import { readString } from "../session/impl/sqliteRow.js";

/**
 * The lifecycle events behind a timeline, narrowed in SQL before any payload is
 * deserialized so a chart never materializes the history it does not draw.
 */
export function queryTimelineEvents(
    tx: TX,
    sessionIds: readonly string[],
): readonly SessionEvent[] {
    if (sessionIds.length === 0) return [];
    const ids = sql.join(
        sessionIds.map((id) => sql`${id}`),
        sql`, `,
    );
    const types = sql.join(
        TIMELINE_EVENT_TYPES.map((type) => sql`${type}`),
        sql`, `,
    );
    return tx
        .all<Record<string, unknown>>(sql`
            SELECT session_id, event_id, type, created_at_ms, data_json
            FROM session_events
            WHERE session_id IN (${ids}) AND type IN (${types})
            ORDER BY session_id ASC, seq ASC
        `)
        .map((row) => readSessionEventRow(row, readString(row, "session_id")));
}
