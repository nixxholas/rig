import type { Context } from "@steve.kite/stdlib";

import { inDatabase } from "../database/inDatabase.js";
import { and, eq } from "drizzle-orm";

import { queuedRuns } from "../database/schema.js";

export async function sessionDeleteQueuedRun(
    ctx: Context,
    sessionId: string,
    runId: string,
): Promise<void> {
    return await inDatabase(ctx, "rig.sql.session.session_delete_queued_run", async (ctx) => {
        const tx = ctx.tx;
        await tx
            .delete(queuedRuns)
            .where(and(eq(queuedRuns.sessionId, sessionId), eq(queuedRuns.runId, runId)))
            .run();
    });
}
