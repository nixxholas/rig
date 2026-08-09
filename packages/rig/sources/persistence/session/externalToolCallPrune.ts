import { inDatabase } from "../database/inDatabase.js";
import { and, desc, eq, notInArray, or, sql } from "drizzle-orm";

import { externalToolCalls } from "../database/schema.js";
import type { DatabaseScope } from "../Transaction.js";

export async function externalToolCallPrune(
    tx: DatabaseScope,
    sessionId: string,
    retain: number,
): Promise<void> {
    return await inDatabase(tx, async (tx) => {
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
