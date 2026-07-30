import { sql, type SQL } from "drizzle-orm";

import type { SessionEvent } from "../../protocol/index.js";
import type { PersistedSessionMessage } from "../../server/InMemorySession.js";
import type { TX } from "../Transaction.js";
import { readSessionEventRow } from "./impl/sessionEventRow.js";

export function querySessionTranscriptEvents(
    tx: TX,
    sessionId: string,
    messages: readonly PersistedSessionMessage[],
): SessionEvent[] {
    const runIds = [...new Set(messages.flatMap((entry) => entry.runId ?? []))];
    const messageIds = messages.map((entry) => entry.message.id);
    const toolCallIds = messages.flatMap((entry) =>
        entry.message.blocks.flatMap((block) => (block.type === "tool_call" ? [block.id] : [])),
    );
    const clauses: SQL[] = [];
    if (runIds.length > 0) {
        clauses.push(
            sql`run_id IN (${sql.join(
                runIds.map((id) => sql`${id}`),
                sql`, `,
            )})`,
        );
    }
    if (messageIds.length > 0) {
        clauses.push(
            sql`message_id IN (${sql.join(
                messageIds.map((id) => sql`${id}`),
                sql`, `,
            )})`,
        );
    }
    if (toolCallIds.length > 0) {
        clauses.push(
            sql`tool_call_id IN (${sql.join(
                toolCallIds.map((id) => sql`${id}`),
                sql`, `,
            )})`,
        );
    }
    if (clauses.length === 0) return [];
    return tx
        .all<Record<string, unknown>>(sql`
            SELECT event_id, type, created_at_ms, data_json
            FROM session_events
            WHERE session_id = ${sessionId} AND (${sql.join(clauses, sql` OR `)})
            ORDER BY seq ASC
        `)
        .map((row) => readSessionEventRow(row, sessionId));
}
