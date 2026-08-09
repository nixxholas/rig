import { inDatabase } from "../database/inDatabase.js";
import { and, desc, eq, notInArray, or } from "drizzle-orm";

import { durableWaits } from "../database/schema.js";
import type { DatabaseScope } from "../Transaction.js";

export async function durableWaitPrune(
    tx: DatabaseScope,
    sessionId: string,
    retain: number,
): Promise<void> {
    return await inDatabase(tx, async (tx) => {
        const prunable = or(eq(durableWaits.status, "cancelled"), eq(durableWaits.consumed, true));
        const retained = tx
            .select({ id: durableWaits.id })
            .from(durableWaits)
            .where(and(eq(durableWaits.sessionId, sessionId), prunable))
            .orderBy(desc(durableWaits.createdAtMs), desc(durableWaits.toolCallIndex))
            .limit(retain);
        await tx
            .delete(durableWaits)
            .where(
                and(
                    eq(durableWaits.sessionId, sessionId),
                    prunable,
                    notInArray(durableWaits.id, retained),
                ),
            )
            .run();
    });
}
