import { and, desc, eq, notInArray, or, sql } from "drizzle-orm";

import { durableUserInputs } from "../database/schema.js";
import type { TX } from "../Transaction.js";

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

export function durableUserInputPrune(tx: TX, sessionId: string, retain: number): void {
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
