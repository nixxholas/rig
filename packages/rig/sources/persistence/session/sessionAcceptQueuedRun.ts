import { eq } from "drizzle-orm";

import type { SessionEvent } from "../../protocol/index.js";
import type { PersistedQueuedRun, PersistedSessionMessage } from "../../session/InMemorySession.js";
import { sessions } from "../database/schema.js";
import { inTx } from "../inTx.js";
import type { DatabaseScope } from "../Transaction.js";
import { sessionAppendEvent } from "./sessionAppendEvent.js";
import { sessionSaveMessage } from "./sessionSaveMessage.js";
import { sessionSaveQueuedRun } from "./sessionSaveQueuedRun.js";

export interface SessionAcceptQueuedRunInput {
    event: Extract<SessionEvent, { type: "message_submitted" }>;
    message: PersistedSessionMessage;
    now: number;
    run: PersistedQueuedRun;
    sessionId: string;
    status: "queued" | "running";
    workspaceQueueWaiting: boolean;
}

/** Durably accepts one visible user message and its run as a single consistency boundary. */
export async function sessionAcceptQueuedRun(
    tx: DatabaseScope,
    input: SessionAcceptQueuedRunInput,
): Promise<void> {
    await inTx(tx, async (tx) => {
        await sessionSaveQueuedRun(tx, input.sessionId, input.run, input.now);
        await sessionSaveMessage(tx, input.sessionId, input.message, input.now);
        await sessionAppendEvent(
            tx,
            input.event,
            {
                messageId: input.event.data.message.id,
                runId: input.event.data.runId,
            },
            input.now,
        );
        await tx
            .update(sessions)
            .set({
                interrupted: false,
                interruptionJson: null,
                lastMessageAtMs: input.now,
                status: input.status,
                updatedAtMs: input.now,
                workspaceQueueWaiting: input.workspaceQueueWaiting
                    ? true
                    : sessions.workspaceQueueWaiting,
            })
            .where(eq(sessions.id, input.sessionId))
            .run();
    });
}
