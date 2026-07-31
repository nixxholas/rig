import { and, desc, eq, notInArray, or } from "drizzle-orm";

import { durableWaits } from "../database/schema.js";
import type { TX } from "../Transaction.js";

export function durableWaitPrune(tx: TX, sessionId: string, retain: number): void {
    const prunable = or(eq(durableWaits.status, "cancelled"), eq(durableWaits.consumed, true));
    const retained = tx
        .select({ id: durableWaits.id })
        .from(durableWaits)
        .where(and(eq(durableWaits.sessionId, sessionId), prunable))
        .orderBy(desc(durableWaits.createdAtMs), desc(durableWaits.toolCallIndex))
        .limit(retain);
    tx.delete(durableWaits)
        .where(
            and(
                eq(durableWaits.sessionId, sessionId),
                prunable,
                notInArray(durableWaits.id, retained),
            ),
        )
        .run();
}
