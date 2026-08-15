import type { Context } from "@steve.kite/stdlib";

import { and, eq } from "drizzle-orm";

import { queuedRuns, sessions } from "../database/schema.js";
import { inTx } from "../inTx.js";

export async function sessionReconcileTerminalRun(
    ctx: Context,
    input: {
        lastEventId: string | null;
        runId: string;
        sessionId: string;
        status: string;
        updatedAt: number;
    },
): Promise<void> {
    await inTx(ctx, "rig.sql.session.session_reconcile_terminal_run", async (ctx) => {
        const tx = ctx.tx;
        await tx
            .update(sessions)
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
        await tx
            .delete(queuedRuns)
            .where(
                and(eq(queuedRuns.sessionId, input.sessionId), eq(queuedRuns.runId, input.runId)),
            )
            .run();
    });
}
