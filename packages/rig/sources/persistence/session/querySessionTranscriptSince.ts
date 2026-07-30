import { sql } from "drizzle-orm";

import type { Message } from "../../agent/types.js";
import type { EventId } from "../../protocol/index.js";
import type { PersistedSessionMessage } from "../../server/InMemorySession.js";
import type { TX } from "../Transaction.js";
import { readNumber, readString } from "./impl/sqliteRow.js";

export function querySessionTranscriptSince(
    tx: TX,
    sessionId: string,
    turnLimit: number,
    after: EventId,
): PersistedSessionMessage[] | undefined {
    const runRows = tx.all<Record<string, unknown>>(sql`
        WITH anchor_run AS (
            SELECT turns.first_position
            FROM session_events AS events
            JOIN session_messages AS messages
              ON messages.session_id = events.session_id
             AND messages.message_id = events.message_id
             AND messages.is_partial = 0
            JOIN session_turns AS turns
              ON turns.session_id = messages.session_id
             AND turns.run_id = messages.run_id
            WHERE events.session_id = ${sessionId} AND events.event_id = ${after}
            LIMIT 1
        )
        SELECT turns.run_id FROM session_turns AS turns
        WHERE turns.session_id = ${sessionId}
          AND turns.first_position >= (SELECT first_position FROM anchor_run)
        ORDER BY turns.first_position ASC
        LIMIT ${turnLimit}
    `);
    if (runRows.length === 0) return undefined;
    const runIds = runRows.map((row) => readString(row, "run_id"));
    return tx
        .all<Record<string, unknown>>(sql`
            SELECT position, is_partial, run_id, message_json
            FROM session_messages
            WHERE session_id = ${sessionId}
                AND is_partial = 0
                AND run_id IN (${sql.join(
                    runIds.map((id) => sql`${id}`),
                    sql`, `,
                )})
            ORDER BY position ASC
        `)
        .map((row) => ({
            isPartial: readNumber(row, "is_partial") !== 0,
            message: JSON.parse(readString(row, "message_json")) as Message,
            position: readNumber(row, "position"),
            runId: readString(row, "run_id"),
        }));
}
