import type { Context } from "@steve.kite/stdlib";

import { inDatabase } from "../database/inDatabase.js";
import { and, eq, sql } from "drizzle-orm";

import { sessions } from "../database/schema.js";

export async function queryWorkspaceHasAttachedSessions(
    ctx: Context,
    workspaceId: string,
): Promise<boolean> {
    return await inDatabase(
        ctx,
        "rig.sql.session.query_workspace_has_attached_sessions",
        async (ctx) => {
            const tx = ctx.tx;
            const row = await tx
                .select({ count: sql<number>`count(*)` })
                .from(sessions)
                .where(and(eq(sessions.workspaceId, workspaceId), eq(sessions.archived, false)))
                .get();
            return (row?.count ?? 0) > 0;
        },
    );
}
