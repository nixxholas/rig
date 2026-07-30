import { and, eq } from "drizzle-orm";

import { queuedRuns, sessions } from "../database/schema.js";
import { inTx } from "../inTx.js";
import type { TX } from "../Transaction.js";

export function sessionReconcileTerminalRun(
    tx: TX,
    input: {
        lastEventId: string | null;
        runId: string;
        sessionId: string;
        status: string;
        updatedAt: number;
    },
): void {
    inTx(tx, (tx) => {
        tx.update(sessions)
            .set({
                activeRunId: null,
                activeSinceMs: null,
                interrupted: false,
                interruptionJson: null,
                lastEventId: input.lastEventId,
                status: input.status,
                updatedAtMs: input.updatedAt,
            })
            .where(eq(sessions.id, input.sessionId))
            .run();
        tx.delete(queuedRuns)
            .where(
                and(eq(queuedRuns.sessionId, input.sessionId), eq(queuedRuns.runId, input.runId)),
            )
            .run();
    });
}
