import { sql } from "drizzle-orm";
import type { TX } from "../Transaction.js";

export function querySessionHasEarlierTranscriptMessage(
    tx: TX,
    sessionId: string,
    position: number,
): boolean {
    return (
        tx.get(sql`
            SELECT 1 FROM session_messages
            WHERE session_id = ${sessionId}
              AND position < ${position}
              AND is_partial = 0
              AND run_id IS NOT NULL
              AND COALESCE(json_extract(message_json, '$.internal'), 0) != 1
            LIMIT 1
        `) !== undefined
    );
}
