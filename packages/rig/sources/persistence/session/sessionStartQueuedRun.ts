import type { Context } from "@steve.kite/stdlib";

import { eq } from "drizzle-orm";

import type { SessionEvent } from "../../protocol/index.js";
import { sessions } from "../database/schema.js";
import { inTx } from "../inTx.js";
import { sessionAppendEvent } from "./sessionAppendEvent.js";
import { sessionDeleteQueuedRun } from "./sessionDeleteQueuedRun.js";

export interface SessionStartQueuedRunInput {
    activeSince: number;
    event: Extract<SessionEvent, { type: "run_started" }>;
    now: number;
    runId: string;
    sessionId: string;
}

/** Moves one run from the durable FIFO into the active slot without a crash-visible gap. */
export async function sessionStartQueuedRun(
    ctx: Context,
    input: SessionStartQueuedRunInput,
): Promise<void> {
    await inTx(ctx, "rig.sql.session.session_start_queued_run", async (ctx) => {
        const tx = ctx.tx;
        await sessionDeleteQueuedRun(ctx, input.sessionId, input.runId);
        await sessionAppendEvent(ctx, input.event, { runId: input.runId }, input.now);
        await tx
            .update(sessions)
            .set({
                activeRunId: input.runId,
                activeSinceMs: input.activeSince,
                interrupted: false,
                interruptionJson: null,
                status: "running",
                updatedAtMs: input.now,
                workspaceQueueWaiting: false,
            })
            .where(eq(sessions.id, input.sessionId))
            .run();
    });
}
