import type { Context } from "@steve.kite/stdlib";

import { inDatabase } from "../database/inDatabase.js";
import { and, asc, eq, min } from "drizzle-orm";

import { queuedRuns, sessions } from "../database/schema.js";

/** Sessions whose durable FIFO must be reconsidered after one workspace lifecycle event. */
export async function queryWorkspaceQueuedSessionIds(
    ctx: Context,
    workspaceId: string,
): Promise<readonly string[]> {
    return await inDatabase(
        ctx,
        "rig.sql.session.query_workspace_queued_session_ids",
        async (ctx) => {
            const tx = ctx.tx;
            return (
                await tx
                    .select({
                        firstQueuedAtMs: min(queuedRuns.createdAtMs),
                        id: sessions.id,
                    })
                    .from(sessions)
                    .innerJoin(queuedRuns, eq(queuedRuns.sessionId, sessions.id))
                    .where(
                        and(
                            eq(sessions.workspaceId, workspaceId),
                            eq(sessions.workspaceQueueWaiting, true),
                        ),
                    )
                    .groupBy(sessions.id)
                    .orderBy(
                        asc(min(queuedRuns.createdAtMs)),
                        asc(sessions.createdAtMs),
                        asc(sessions.id),
                    )
                    .all()
            ).map((row) => row.id);
        },
    );
}
