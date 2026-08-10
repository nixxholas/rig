import type { Context } from "@steve.kite/stdlib";

import { inDatabase } from "../database/inDatabase.js";
import { sql } from "drizzle-orm";

import { projectWorkspaces } from "../database/schema.js";
import { workspaceScope } from "./workspaceScope.js";

/** Records the branch a workspace is actually on, after Git has moved it or refused to. */
export async function workspaceSetBranch(
    ctx: Context,
    projectId: string,
    id: string,
    branch: string,
    now: number,
): Promise<number> {
    return await inDatabase(ctx, "rig.sql.project.workspaceSetBranch", async (ctx) => {
        const tx = ctx.tx;
        return Number(
            (
                await tx
                    .update(projectWorkspaces)
                    .set({
                        branch,
                        updatedAtMs: now,
                        version: sql`${projectWorkspaces.version} + 1`,
                    })
                    .where(workspaceScope(projectId, id))
                    .run()
            ).rowsAffected,
        );
    });
}
