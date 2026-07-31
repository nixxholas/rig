import { and, desc, eq, inArray } from "drizzle-orm";

import { scheduledMessages } from "../database/schema.js";
import type { TX } from "../Transaction.js";

export function scheduledMessagePrune(
    tx: TX,
    senderSessionId: string,
    retain: number,
): readonly string[] {
    const prunable = inArray(scheduledMessages.status, ["cancelled", "delivered"]);
    const removed = tx
        .select({ id: scheduledMessages.id })
        .from(scheduledMessages)
        .where(and(eq(scheduledMessages.senderSessionId, senderSessionId), prunable))
        .orderBy(
            desc(scheduledMessages.updatedAtMs),
            desc(scheduledMessages.createdAtMs),
            desc(scheduledMessages.id),
        )
        .all()
        .slice(retain)
        .map((message) => message.id);
    if (removed.length === 0) return [];
    tx.delete(scheduledMessages).where(inArray(scheduledMessages.id, removed)).run();
    return removed;
}
