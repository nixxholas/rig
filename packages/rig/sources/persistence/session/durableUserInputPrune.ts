import { and, desc, eq, notInArray, or, sql } from "drizzle-orm";

import { durableUserInputs } from "../database/schema.js";
import type { TX } from "../Transaction.js";

export function durableUserInputPrune(tx: TX, sessionId: string, retain: number): void {
    const prunable = or(
        eq(durableUserInputs.status, "cancelled"),
        eq(durableUserInputs.consumed, true),
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
    tx.delete(durableUserInputs)
        .where(
            and(
                eq(durableUserInputs.sessionId, sessionId),
                prunable,
                notInArray(durableUserInputs.requestId, retained),
            ),
        )
        .run();
}
