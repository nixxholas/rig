import { and, eq, inArray } from "drizzle-orm";

import { happyOutbox } from "../database/schema.js";
import type { TX } from "../Transaction.js";

export function happyOutboxAcknowledge(
    tx: TX,
    sessionId: string,
    localIds: readonly string[],
): void {
    if (localIds.length === 0) return;
    tx.delete(happyOutbox)
        .where(and(eq(happyOutbox.sessionId, sessionId), inArray(happyOutbox.localId, localIds)))
        .run();
}
