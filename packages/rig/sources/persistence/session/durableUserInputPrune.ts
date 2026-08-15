import type { Context } from "@steve.kite/stdlib";

import { inDatabase } from "../database/inDatabase.js";
import { and, desc, eq, notInArray, or, sql } from "drizzle-orm";

import { durableUserInputs } from "../database/schema.js";

/**
 * Mirrors `isOpenQuestion`: a question the user could still answer, including one that presence
 * released the agent from waiting for.
 */
const openQuestion = and(
    eq(durableUserInputs.kind, "question"),
    sql`${durableUserInputs.responseJson} IS NULL`,
    sql`${durableUserInputs.status} <> 'cancelled'`,
    or(eq(durableUserInputs.status, "pending"), sql`${durableUserInputs.detachedAtMs} IS NOT NULL`),
);

export async function durableUserInputPrune(
    ctx: Context,
    sessionId: string,
    retain: number,
): Promise<void> {
    return await inDatabase(ctx, "rig.sql.session.durable_user_input_prune", async (ctx) => {
        const tx = ctx.tx;
        const prunable = or(
            eq(durableUserInputs.status, "cancelled"),
            and(eq(durableUserInputs.consumed, true), sql`NOT (${openQuestion})`),
        );
        const retained = tx
            .select({ requestId: durableUserInputs.requestId })
            .from(durableUserInputs)
            .where(and(eq(durableUserInputs.sessionId, sessionId), prunable))
            .orderBy(
                desc(
                    sql`COALESCE(${durableUserInputs.resolvedAtMs}, ${durableUserInputs.createdAtMs})`,
                ),
                desc(durableUserInputs.toolCallIndex),
            )
            .limit(retain);
        await tx
            .delete(durableUserInputs)
            .where(
                and(
                    eq(durableUserInputs.sessionId, sessionId),
                    prunable,
                    notInArray(durableUserInputs.requestId, retained),
                ),
            )
            .run();
    });
}
