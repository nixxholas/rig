import { sql, type SQL } from "drizzle-orm";

import {
    TOOL_RESULT_PRESENTATION_MAXIMUM_OUTPUT_CHARACTERS,
    TOOL_RESULT_PRESENTATION_RETAINED_OUTPUT_CHARACTERS,
    TOOL_RESULT_PRESENTATION_TRUNCATION_NOTICE,
} from "../../agent/boundToolResultPresentation.js";
import { inTx } from "../inTx.js";
import type { TX } from "../Transaction.js";
import { readNumber, readString } from "./impl/sqliteRow.js";

export interface SessionToolResultPruneCursor {
    position: number;
    sessionId: string;
}

export type SessionToolResultPrunePage =
    | { complete: true; pruned: number }
    | { complete: false; cursor: SessionToolResultPruneCursor; pruned: number };

/**
 * Inspects one bounded page of durable transcript rows, clearing stale tool payloads and bounding
 * pre-existing command presentations.
 *
 * Provider context lives in `session_context_messages` and is deliberately outside this
 * operation. Session and message activity timestamps are also left unchanged: maintenance must
 * not make an old chat look active.
 */
export function sessionPruneToolResults(
    tx: TX,
    input: { after?: SessionToolResultPruneCursor; before: number; limit: number },
): SessionToolResultPrunePage {
    return inTx(tx, (tx) => {
        const after: SQL =
            input.after === undefined
                ? sql`1`
                : sql`
                    (session_id, position)
                        > (${input.after.sessionId}, ${input.after.position})
                `;
        const rows = tx.all<Record<string, unknown>>(sql`
            SELECT session_id, position
            FROM session_messages
            WHERE ${after}
            ORDER BY session_id ASC, position ASC
            LIMIT ${input.limit}
        `);
        if (rows.length === 0) return { complete: true, pruned: 0 };
        const last = rows.at(-1)!;
        const cursor = {
            position: readNumber(last, "position"),
            sessionId: readString(last, "session_id"),
        };

        const keys = rows.map(
            (row) => sql`(${readString(row, "session_id")}, ${readNumber(row, "position")})`,
        );
        const stale = sql`
            EXISTS (
                SELECT 1
                FROM sessions AS session
                WHERE session.id = message.session_id
                    AND session.active_run_id IS NULL
                    AND session.status NOT IN ('queued', 'running')
                    AND MAX(
                        COALESCE(session.last_message_at_ms, session.created_at_ms),
                        session.updated_at_ms
                    ) < ${input.before}
            )
        `;
        const hasRetainedOutput = sql`
            json_extract(block.value, '$.type') = 'tool_result'
            AND json_type(block.value, '$.rendered') = 'array'
            AND json_array_length(block.value, '$.rendered') > 0
        `;
        const hasOversizedPresentation = sql`
            json_extract(block.value, '$.type') = 'tool_result'
            AND json_extract(block.value, '$.presentation.type') = 'exec_command'
            AND length(json_extract(block.value, '$.presentation.output'))
                > ${TOOL_RESULT_PRESENTATION_MAXIMUM_OUTPUT_CHARACTERS}
        `;
        const changed = tx.run(sql`
            UPDATE session_messages AS message
            SET message_json = json_set(
                message.message_json,
                '$.blocks',
                (
                    SELECT json_group_array(
                        json(
                            CASE
                                WHEN ${hasOversizedPresentation}
                                THEN json_set(
                                    CASE
                                        WHEN ${stale} AND ${hasRetainedOutput}
                                        THEN json_set(block.value, '$.rendered', json('[]'))
                                        ELSE block.value
                                    END,
                                    '$.presentation.output',
                                    ${TOOL_RESULT_PRESENTATION_TRUNCATION_NOTICE} || substr(
                                        json_extract(block.value, '$.presentation.output'),
                                        -${TOOL_RESULT_PRESENTATION_RETAINED_OUTPUT_CHARACTERS}
                                    )
                                )
                                WHEN ${stale} AND ${hasRetainedOutput}
                                THEN json_set(block.value, '$.rendered', json('[]'))
                                ELSE block.value
                            END
                        )
                    )
                    FROM json_each(message.message_json, '$.blocks') AS block
                )
            )
            WHERE (message.session_id, message.position) IN (${sql.join(keys, sql`, `)})
                AND message.role = 'agent'
                AND EXISTS (
                    SELECT 1
                    FROM json_each(message.message_json, '$.blocks') AS block
                    WHERE (${stale} AND ${hasRetainedOutput})
                        OR ${hasOversizedPresentation}
                )
        `).changes;

        if (rows.length < input.limit) return { complete: true, pruned: changed };
        return { complete: false, cursor, pruned: changed };
    });
}
