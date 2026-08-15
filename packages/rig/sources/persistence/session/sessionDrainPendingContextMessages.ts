import type { Context } from "@steve.kite/stdlib";

import { and, eq, inArray, sql } from "drizzle-orm";

import { pendingContextMessages, sessionContextMessages } from "../database/schema.js";
import type { PersistedPendingContextMessage } from "../../session/InMemorySession.js";
import { inTx } from "../inTx.js";
import { queryPendingContextMessages } from "./queryPendingContextMessages.js";

export async function sessionDrainPendingContextMessages(
    ctx: Context,
    sessionId: string,
    messageIds?: readonly string[],
): Promise<readonly PersistedPendingContextMessage[]> {
    if (messageIds?.length === 0) return [];
    return await inTx(
        ctx,
        "rig.sql.session.session_drain_pending_context_messages",
        async (ctx) => {
            const tx = ctx.tx;
            const requested = messageIds === undefined ? undefined : new Set(messageIds);
            const pending = (await queryPendingContextMessages(ctx, sessionId)).filter(
                (entry) => requested === undefined || requested.has(entry.message.id),
            );
            if (pending.length === 0) return [];
            let position =
                (
                    await tx.get<{ position: number }>(sql`
                    SELECT COALESCE(MAX(position), -1) AS position
                    FROM session_context_messages
                    WHERE session_id = ${sessionId}
                `)
                )?.position ?? -1;
            const existingIds = new Set(
                (
                    await tx.all<{ messageId: string }>(sql`
                    SELECT message_id AS messageId
                    FROM session_context_messages
                    WHERE session_id = ${sessionId}
                `)
                ).map((row) => row.messageId),
            );
            for (const entry of pending) {
                if (existingIds.has(entry.message.id)) continue;
                position += 1;
                await tx
                    .insert(sessionContextMessages)
                    .values({
                        messageId: entry.message.id,
                        messageJson: JSON.stringify(entry.message),
                        position,
                        role: entry.message.role,
                        sessionId,
                    })
                    .run();
            }
            await tx
                .delete(pendingContextMessages)
                .where(
                    and(
                        eq(pendingContextMessages.sessionId, sessionId),
                        inArray(
                            pendingContextMessages.messageId,
                            pending.map((entry) => entry.message.id),
                        ),
                    ),
                )
                .run();
            return pending;
        },
    );
}
