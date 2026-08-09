import { inDatabase } from "../database/inDatabase.js";
import { sql } from "drizzle-orm";
import type { DatabaseScope } from "../Transaction.js";

export async function querySessionHasLaterTranscriptMessage(
    tx: DatabaseScope,
    sessionId: string,
    position: number,
): Promise<boolean> {
    return await inDatabase(tx, async (tx) => {
        return (
            (await tx.get(sql`
            SELECT 1 FROM session_messages
            WHERE session_id = ${sessionId}
              AND position > ${position}
              AND is_partial = 0
              AND run_id IS NOT NULL
              AND COALESCE(json_extract(message_json, '$.internal'), 0) != 1
            LIMIT 1
        `)) !== undefined
        );
    });
}
