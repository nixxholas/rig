import type { Context } from "@steve.kite/stdlib";

import { inDatabase } from "../database/inDatabase.js";
import { sql } from "drizzle-orm";

export async function querySessionHasLaterTranscriptMessage(
    ctx: Context,
    sessionId: string,
    position: number,
): Promise<boolean> {
    return await inDatabase(
        ctx,
        "rig.sql.session.query_session_has_later_transcript_message",
        async (ctx) => {
            const tx = ctx.tx;
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
        },
    );
}
