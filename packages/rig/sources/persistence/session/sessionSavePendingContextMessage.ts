import type { Context } from "@steve.kite/stdlib";

import { pendingContextMessages } from "../database/schema.js";
import type {
    PersistedPendingContextMessage,
    PersistedSessionMessage,
} from "../../session/InMemorySession.js";
import { inTx } from "../inTx.js";
import { sessionSaveMessage } from "./sessionSaveMessage.js";

export async function sessionSavePendingContextMessage(
    ctx: Context,
    sessionId: string,
    pending: PersistedPendingContextMessage,
    updatedAt: number,
): Promise<void> {
    await inTx(ctx, "rig.sql.session.session_save_pending_context_message", async (ctx) => {
        const tx = ctx.tx;
        const stored: PersistedSessionMessage = {
            isPartial: false,
            message: pending.message,
            position: pending.position,
            runId: pending.anchorRunId,
        };
        await sessionSaveMessage(ctx, sessionId, stored, updatedAt);
        await tx
            .insert(pendingContextMessages)
            .values({
                anchorRunId: pending.anchorRunId,
                createdAtMs: pending.createdAt,
                messageId: pending.message.id,
                position: pending.position,
                sessionId,
            })
            .onConflictDoNothing()
            .run();
    });
}
