import { pendingContextMessages } from "../database/schema.js";
import type {
    PersistedPendingContextMessage,
    PersistedSessionMessage,
} from "../../session/InMemorySession.js";
import { inTx } from "../inTx.js";
import type { TX } from "../Transaction.js";
import { sessionSaveMessage } from "./sessionSaveMessage.js";

export function sessionSavePendingContextMessage(
    tx: TX,
    sessionId: string,
    pending: PersistedPendingContextMessage,
    updatedAt: number,
): void {
    inTx(tx, (tx) => {
        const stored: PersistedSessionMessage = {
            isPartial: false,
            message: pending.message,
            position: pending.position,
            runId: pending.anchorRunId,
        };
        sessionSaveMessage(tx, sessionId, stored, updatedAt);
        tx.insert(pendingContextMessages)
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
