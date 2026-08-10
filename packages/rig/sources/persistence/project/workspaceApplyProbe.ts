import type { Context } from "@steve.kite/stdlib";

import { inDatabase } from "../database/inDatabase.js";
import { and, eq, sql } from "drizzle-orm";
import { projectWorkspaces } from "../database/schema.js";
import { type GitValues, workspaceGitChanged } from "./projectConditions.js";
import { workspaceScope } from "./workspaceScope.js";

export async function workspaceApplyProbe(
    ctx: Context,
    projectId: string,
    id: string,
    values: GitValues & { presence: string },
    now: number,
): Promise<number> {
    return await inDatabase(ctx, "rig.sql.project.workspaceApplyProbe", async (ctx) => {
        const tx = ctx.tx;
        return Number(
            (
                await tx
                    .update(projectWorkspaces)
                    .set({
                        ...values,
                        updatedAtMs: now,
                        version: sql`${projectWorkspaces.version} + 1`,
                    })
                    .where(
                        and(
                            workspaceScope(projectId, id),
                            eq(projectWorkspaces.status, "ready"),
                            sql`(
        ${projectWorkspaces.presence} IS NOT ${values.presence} OR ${workspaceGitChanged(values)}
    )`,
                        ),
                    )
                    .run()
            ).rowsAffected,
        );
    });
}
