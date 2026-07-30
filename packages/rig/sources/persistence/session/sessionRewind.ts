import { and, eq, gte, sql } from "drizzle-orm";

import { sessionMessages, sessionTurns } from "../database/schema.js";
import { inTx } from "../inTx.js";
import type { TX } from "../Transaction.js";

export function sessionRewind(tx: TX, sessionId: string, position: number): void {
    inTx(tx, (tx) => {
        tx.delete(sessionMessages)
            .where(
                and(
                    eq(sessionMessages.sessionId, sessionId),
                    gte(sessionMessages.position, position),
                ),
            )
            .run();
        tx.delete(sessionTurns).where(eq(sessionTurns.sessionId, sessionId)).run();
        tx.run(sql`
            INSERT INTO session_turns (session_id, run_id, first_position)
            SELECT session_id, run_id, MIN(position)
            FROM session_messages
            WHERE session_id = ${sessionId} AND run_id IS NOT NULL AND is_partial = 0
            GROUP BY session_id, run_id
        `);
    });
}
