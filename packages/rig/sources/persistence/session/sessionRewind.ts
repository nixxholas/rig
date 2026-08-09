import { and, eq, gte, sql } from "drizzle-orm";

import { pendingContextMessages, sessionMessages, sessionTurns } from "../database/schema.js";
import { inTx } from "../inTx.js";
import type { DatabaseScope } from "../Transaction.js";

export async function sessionRewind(
    tx: DatabaseScope,
    sessionId: string,
    position: number,
): Promise<void> {
    await inTx(tx, async (tx) => {
        await tx
            .delete(pendingContextMessages)
            .where(
                and(
                    eq(pendingContextMessages.sessionId, sessionId),
                    gte(pendingContextMessages.position, position),
                ),
            )
            .run();
        await tx
            .delete(sessionMessages)
            .where(
                and(
                    eq(sessionMessages.sessionId, sessionId),
                    gte(sessionMessages.position, position),
                ),
            )
            .run();
        await tx.delete(sessionTurns).where(eq(sessionTurns.sessionId, sessionId)).run();
        await tx.run(sql`
            INSERT INTO session_turns (session_id, run_id, first_position)
            SELECT session_id, run_id, MIN(position)
            FROM session_messages
            WHERE session_id = ${sessionId} AND run_id IS NOT NULL AND is_partial = 0
            GROUP BY session_id, run_id
        `);
    });
}
