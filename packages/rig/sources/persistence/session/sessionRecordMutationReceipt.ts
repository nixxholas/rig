import { inDatabase } from "../database/inDatabase.js";
import { sql } from "drizzle-orm";

import type { DatabaseScope } from "../Transaction.js";

const MAX_SESSION_MUTATION_RECEIPTS = 10_000;

/** Records one applied session mutation and keeps the receipt table explicitly bounded. */
export async function sessionRecordMutationReceipt(
    tx: DatabaseScope,
    input: { action: string; mutationId: string; now: number; sessionId: string },
): Promise<void> {
    return await inDatabase(tx, async (tx) => {
        await tx.run(sql`
        INSERT INTO session_mutations (mutation_id, action, session_id, created_at_ms)
        VALUES (${input.mutationId}, ${input.action}, ${input.sessionId}, ${input.now})
    `);
        await tx.run(sql`
        DELETE FROM session_mutations
        WHERE mutation_id IN (
            SELECT mutation_id
            FROM session_mutations
            ORDER BY created_at_ms DESC, mutation_id DESC
            LIMIT -1 OFFSET ${MAX_SESSION_MUTATION_RECEIPTS}
        )
    `);
    });
}
