import { inDatabase } from "../database/inDatabase.js";
import { sql } from "drizzle-orm";
import type { DatabaseScope } from "../Transaction.js";

export async function querySessionHasEarlierStoredMessage(
    tx: DatabaseScope,
    sessionId: string,
    earliestPosition: number | undefined,
): Promise<boolean> {
    return await inDatabase(tx, async (tx) => {
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
    });
}
