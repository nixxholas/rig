import { inDatabase } from "../database/inDatabase.js";
import { and, desc, eq, inArray } from "drizzle-orm";

import { scheduledMessages } from "../database/schema.js";
import type { DatabaseScope } from "../Transaction.js";

export async function scheduledMessagePrune(
    tx: DatabaseScope,
    senderSessionId: string,
    retain: number,
): Promise<readonly string[]> {
    return await inDatabase(tx, async (tx) => {
        const prunable = inArray(scheduledMessages.status, ["cancelled", "delivered"]);
        const removed = (
            await tx
                .select({ id: scheduledMessages.id })
                .from(scheduledMessages)
                .where(and(eq(scheduledMessages.senderSessionId, senderSessionId), prunable))
                .orderBy(
                    desc(scheduledMessages.updatedAtMs),
                    desc(scheduledMessages.createdAtMs),
                    desc(scheduledMessages.id),
                )
                .all()
        )
            .slice(retain)
            .map((message) => message.id);
        if (removed.length === 0) return [];
        await tx.delete(scheduledMessages).where(inArray(scheduledMessages.id, removed)).run();
        return removed;
    });
}
