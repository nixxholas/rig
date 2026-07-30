import { and, desc, eq, notInArray, or, sql } from "drizzle-orm";

import { externalToolCalls } from "../database/schema.js";
import type { TX } from "../Transaction.js";

export function externalToolCallPrune(tx: TX, sessionId: string, retain: number): void {
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
    tx.delete(externalToolCalls)
        .where(
            and(
                eq(externalToolCalls.sessionId, sessionId),
                prunable,
                notInArray(externalToolCalls.id, retained),
            ),
        )
        .run();
}
