import { inDatabase } from "../database/inDatabase.js";
import { sql } from "drizzle-orm";

import type { DatabaseScope } from "../Transaction.js";

export type SessionMutationReceiptResult = "applied" | "conflict" | "missing";

/** Checks one durable mutation identity without depending on the bounded session event cache. */
export async function querySessionMutationReceipt(
    tx: DatabaseScope,
    input: { action: string; mutationId: string; sessionId: string },
): Promise<SessionMutationReceiptResult> {
    return await inDatabase(tx, async (tx) => {
        const receipt = await tx.get<{ action: string; session_id: string }>(sql`
        SELECT action, session_id
        FROM session_mutations
        WHERE mutation_id = ${input.mutationId}
    `);
        if (receipt === undefined) return "missing";
        return receipt.action === input.action && receipt.session_id === input.sessionId
            ? "applied"
            : "conflict";
    });
}
