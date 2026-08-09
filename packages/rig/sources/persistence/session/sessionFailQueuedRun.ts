import { eq } from "drizzle-orm";

import type { SessionEvent } from "../../protocol/index.js";
import { sessions } from "../database/schema.js";
import { inTx } from "../inTx.js";
import type { DatabaseScope } from "../Transaction.js";
import { sessionAppendEvent } from "./sessionAppendEvent.js";
import { sessionDeleteQueuedRun } from "./sessionDeleteQueuedRun.js";

export interface SessionFailQueuedRunInput {
    event: Extract<SessionEvent, { type: "run_error" }>;
    now: number;
    runId: string;
    sessionId: string;
}

/** Fails one queued run durably while retaining its already-committed user message. */
export async function sessionFailQueuedRun(
    tx: DatabaseScope,
    input: SessionFailQueuedRunInput,
): Promise<void> {
    await inTx(tx, async (tx) => {
        await sessionDeleteQueuedRun(tx, input.sessionId, input.runId);
        await sessionAppendEvent(tx, input.event, { runId: input.runId }, input.now);
        await tx
            .update(sessions)
            .set({
                activeRunId: null,
                activeSinceMs: null,
                status: "error",
                updatedAtMs: input.now,
                workspaceQueueWaiting: false,
            })
            .where(eq(sessions.id, input.sessionId))
            .run();
    });
}
