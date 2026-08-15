import type { Context } from "@steve.kite/stdlib";

import { eq } from "drizzle-orm";

import type { SessionEvent } from "../../protocol/index.js";
import { sessions } from "../database/schema.js";
import { inTx } from "../inTx.js";
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
    ctx: Context,
    input: SessionFailQueuedRunInput,
): Promise<void> {
    await inTx(ctx, "rig.sql.session.session_fail_queued_run", async (ctx) => {
        const tx = ctx.tx;
        await sessionDeleteQueuedRun(ctx, input.sessionId, input.runId);
        await sessionAppendEvent(ctx, input.event, { runId: input.runId }, input.now);
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
