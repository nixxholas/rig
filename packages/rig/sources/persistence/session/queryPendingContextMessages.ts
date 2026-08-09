import { inDatabase } from "../database/inDatabase.js";
import { sql } from "drizzle-orm";

import type { UserMessage } from "../../agent/types.js";
import type { PersistedPendingContextMessage } from "../../session/InMemorySession.js";
import type { DatabaseScope } from "../Transaction.js";
import { readNumber, readString } from "./impl/sqliteRow.js";

export async function queryPendingContextMessages(
    tx: DatabaseScope,
    sessionId: string,
): Promise<readonly PersistedPendingContextMessage[]> {
    return await inDatabase(tx, async (tx) => {
        return (
            await tx.all<Record<string, unknown>>(sql`
            SELECT pending.anchor_run_id, pending.created_at_ms, pending.position,
                messages.message_json
            FROM pending_context_messages AS pending
            JOIN session_messages AS messages
              ON messages.session_id = pending.session_id
             AND messages.position = pending.position
            WHERE pending.session_id = ${sessionId}
            ORDER BY pending.position ASC
        `)
        ).map((row) => ({
            anchorRunId: readString(row, "anchor_run_id"),
            createdAt: readNumber(row, "created_at_ms"),
            message: JSON.parse(readString(row, "message_json")) as UserMessage,
            position: readNumber(row, "position"),
        }));
    });
}
