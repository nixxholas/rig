import { sql } from "drizzle-orm";

import type { TX } from "../Transaction.js";

export type SessionMutationReceiptResult = "applied" | "conflict" | "missing";

/** Checks one durable mutation identity without depending on the bounded session event cache. */
export function querySessionMutationReceipt(
    tx: TX,
    input: { action: string; mutationId: string; sessionId: string },
): SessionMutationReceiptResult {
    const receipt = tx.get<{ action: string; session_id: string }>(sql`
        SELECT action, session_id
        FROM session_mutations
        WHERE mutation_id = ${input.mutationId}
    `);
    if (receipt === undefined) return "missing";
    return receipt.action === input.action && receipt.session_id === input.sessionId
        ? "applied"
        : "conflict";
}
