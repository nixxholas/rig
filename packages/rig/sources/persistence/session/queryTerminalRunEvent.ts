import { sql } from "drizzle-orm";

import type { TX } from "../Transaction.js";
import { readOptionalString, readString } from "./impl/sqliteRow.js";

export interface TerminalRunEvent {
    lastEventId: string | null;
    status: "aborted" | "completed" | "error";
}

export function queryTerminalRunEvent(
    tx: TX,
    sessionId: string,
    runId: string,
): TerminalRunEvent | undefined {
    const row = tx.get<Record<string, unknown>>(sql`
        SELECT type, data_json, (
            SELECT event_id FROM session_events AS latest
            WHERE latest.session_id = ${sessionId}
            ORDER BY seq DESC LIMIT 1
        ) AS last_event_id
        FROM session_events
        WHERE session_id = ${sessionId}
            AND type IN ('run_finished', 'run_error')
            AND json_extract(data_json, '$.runId') = ${runId}
        ORDER BY seq DESC LIMIT 1
    `);
    if (row === undefined) return undefined;
    const type = readString(row, "type");
    const data = JSON.parse(readString(row, "data_json")) as { stopReason?: string };
    return {
        lastEventId: readOptionalString(row, "last_event_id") ?? null,
        status:
            type === "run_error"
                ? "error"
                : data.stopReason === "aborted"
                  ? "aborted"
                  : "completed",
    };
}
