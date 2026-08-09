import { inDatabase } from "../database/inDatabase.js";
import { sql } from "drizzle-orm";

import type { ScheduledMessage } from "../../scheduling/index.js";
import { scheduledMessages } from "../database/schema.js";
import type { DatabaseScope } from "../Transaction.js";

export async function scheduledMessageSave(
    tx: DatabaseScope,
    message: ScheduledMessage,
): Promise<void> {
    return await inDatabase(tx, async (tx) => {
        await tx
            .insert(scheduledMessages)
            .values({
                createdAtMs: message.createdAt,
                deliveredAtMs: message.deliveredAt ?? null,
                dueAtMs: message.dueAt,
                failure: message.failure ?? null,
                id: message.id,
                message: message.message,
                senderSessionId: message.senderSessionId,
                status: message.status,
                targetAgentId: message.targetAgentId,
                updatedAtMs: message.updatedAt,
            })
            .onConflictDoUpdate({
                set: {
                    deliveredAtMs: sql`excluded.delivered_at_ms`,
                    failure: sql`excluded.failure`,
                    status: sql`excluded.status`,
                    updatedAtMs: sql`excluded.updated_at_ms`,
                },
                target: scheduledMessages.id,
            })
            .run();
    });
}
