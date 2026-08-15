import type { Context } from "@steve.kite/stdlib";

import { inDatabase } from "../database/inDatabase.js";
import { sql } from "drizzle-orm";

export async function querySessionHasEarlierStoredMessage(
    ctx: Context,
    sessionId: string,
    earliestPosition: number | undefined,
): Promise<boolean> {
    return await inDatabase(
        ctx,
        "rig.sql.session.query_session_has_earlier_stored_message",
        async (ctx) => {
            const tx = ctx.tx;
            return (
                (await tx.get(
                    earliestPosition === undefined
                        ? sql`
                      SELECT 1 FROM session_messages
                      WHERE session_id = ${sessionId} AND is_partial = 0
                      LIMIT 1
                  `
                        : sql`
                      SELECT 1 FROM session_messages
                      WHERE session_id = ${sessionId}
                        AND is_partial = 0
                        AND position < ${earliestPosition}
                      LIMIT 1
                  `,
                )) !== undefined
            );
        },
    );
}
