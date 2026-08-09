import { inDatabase } from "../database/inDatabase.js";
import { and, eq, inArray } from "drizzle-orm";

import { happyOutbox } from "../database/schema.js";
import type { DatabaseScope } from "../Transaction.js";

export async function happyOutboxAcknowledge(
    tx: DatabaseScope,
    sessionId: string,
    localIds: readonly string[],
): Promise<void> {
    return await inDatabase(tx, async (tx) => {
        if (localIds.length === 0) return;
        await tx
            .delete(happyOutbox)
            .where(
                and(eq(happyOutbox.sessionId, sessionId), inArray(happyOutbox.localId, localIds)),
            )
            .run();
    });
}
