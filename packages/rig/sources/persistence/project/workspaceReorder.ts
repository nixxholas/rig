import type { Context } from "@steve.kite/stdlib";

import { inDatabase } from "../database/inDatabase.js";
import { sql } from "drizzle-orm";
import { projectWorkspaces } from "../database/schema.js";
import { workspaceScope } from "./workspaceScope.js";

export async function workspaceReorder(
    ctx: Context,
    projectId: string,
    id: string,
    orderKey: string,
    now: number,
    version?: number,
): Promise<number> {
    return await inDatabase(ctx, "rig.sql.project.workspaceReorder", async (ctx) => {
        const tx = ctx.tx;
        return Number(
            (
                await tx
                    .update(projectWorkspaces)
                    .set({
                        orderKey,
                        updatedAtMs: now,
                        version: sql`${projectWorkspaces.version} + 1`,
                    })
                    .where(workspaceScope(projectId, id, version))
                    .run()
            ).rowsAffected,
        );
    });
}
