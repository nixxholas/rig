import type { Context } from "@steve.kite/stdlib";

import { inDatabase } from "../database/inDatabase.js";
import { and, desc, eq, inArray } from "drizzle-orm";

import { scheduledMessages } from "../database/schema.js";

export async function scheduledMessagePrune(
    ctx: Context,
    senderSessionId: string,
    retain: number,
): Promise<readonly string[]> {
    return await inDatabase(ctx, "rig.sql.scheduling.scheduledMessagePrune", async (ctx) => {
        const tx = ctx.tx;
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
