import type { Context } from "@steve.kite/stdlib";

import { inDatabase } from "../database/inDatabase.js";
import { sql } from "drizzle-orm";

export type SessionMutationReceiptResult = "applied" | "conflict" | "missing";

/** Checks one durable mutation identity without depending on the bounded session event cache. */
export async function querySessionMutationReceipt(
    ctx: Context,
    input: { action: string; mutationId: string; sessionId: string },
): Promise<SessionMutationReceiptResult> {
    return await inDatabase(ctx, "rig.sql.session.query_session_mutation_receipt", async (ctx) => {
        const tx = ctx.tx;
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
