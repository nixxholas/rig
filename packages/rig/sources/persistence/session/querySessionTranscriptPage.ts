import { sql } from "drizzle-orm";

import type { Message } from "../../agent/types.js";
import type { PersistedSessionMessage } from "../../server/InMemorySession.js";
import type { TX } from "../Transaction.js";
import { readNumber, readString } from "./impl/sqliteRow.js";

export function querySessionTranscriptPage(
    tx: TX,
    sessionId: string,
    turnLimit: number,
    before?: string,
): PersistedSessionMessage[] | undefined {
    const runRows = tx.all<Record<string, unknown>>(sql`
        WITH ordered_runs AS (
            SELECT run_id, first_position FROM session_turns WHERE session_id = ${sessionId}
        ),
        anchor AS (
            SELECT first_position FROM ordered_runs WHERE run_id = ${before ?? null}
        )
        SELECT run_id FROM ordered_runs
        WHERE ${before ?? null} IS NULL
            OR first_position < (SELECT first_position FROM anchor)
        ORDER BY first_position DESC
        LIMIT ${turnLimit}
    `);
    if (before !== undefined && runRows.length === 0) {
        const known = tx.get(sql`
            SELECT 1 FROM session_messages
            WHERE session_id = ${sessionId} AND run_id = ${before}
            LIMIT 1
        `);
        if (known === undefined) return undefined;
    }
    const runIds = runRows.map((row) => readString(row, "run_id")).reverse();
    if (runIds.length === 0) return [];
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
