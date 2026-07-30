import { sql } from "drizzle-orm";

import type { Message } from "../../agent/types.js";
import type { PersistedSessionMessage } from "../../server/InMemorySession.js";
import type { TX } from "../Transaction.js";
import { readNumber, readOptionalString, readString } from "./impl/sqliteRow.js";

export function querySessionPartialMessages(tx: TX, sessionId: string): PersistedSessionMessage[] {
    return tx
        .all<Record<string, unknown>>(sql`
            SELECT position, is_partial, run_id, message_json
            FROM session_messages
            WHERE session_id = ${sessionId} AND is_partial = 1
            ORDER BY position ASC
        `)
        .map((row) => {
            const runId = readOptionalString(row, "run_id");
            return {
                isPartial: true,
                message: JSON.parse(readString(row, "message_json")) as Message,
                position: readNumber(row, "position"),
                ...(runId === undefined ? {} : { runId }),
            };
        });
}
