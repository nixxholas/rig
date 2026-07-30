import { sql } from "drizzle-orm";
import type { TX } from "../Transaction.js";

export function querySessionHasEarlierStoredMessage(
    tx: TX,
    sessionId: string,
    earliestPosition: number | undefined,
): boolean {
    return (
        tx.get(
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
        ) !== undefined
    );
}
