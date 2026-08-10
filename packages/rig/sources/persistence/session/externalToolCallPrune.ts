import type { Context } from "@steve.kite/stdlib";

import { inDatabase } from "../database/inDatabase.js";
import { and, desc, eq, notInArray, or, sql } from "drizzle-orm";

import { externalToolCalls } from "../database/schema.js";

export async function externalToolCallPrune(
    ctx: Context,
    sessionId: string,
    retain: number,
): Promise<void> {
    return await inDatabase(ctx, "rig.sql.session.external_tool_call_prune", async (ctx) => {
        const tx = ctx.tx;
        const prunable = or(
            eq(externalToolCalls.status, "cancelled"),
            eq(externalToolCalls.consumed, true),
        );
        const retained = tx
            .select({ id: externalToolCalls.id })
            .from(externalToolCalls)
            .where(and(eq(externalToolCalls.sessionId, sessionId), prunable))
            .orderBy(
                desc(
                    sql`COALESCE(${externalToolCalls.resolvedAtMs}, ${externalToolCalls.createdAtMs})`,
                ),
                desc(externalToolCalls.toolCallIndex),
            )
            .limit(retain);
        await tx
            .delete(externalToolCalls)
            .where(
                and(
                    eq(externalToolCalls.sessionId, sessionId),
                    prunable,
                    notInArray(externalToolCalls.id, retained),
                ),
            )
            .run();
    });
}
