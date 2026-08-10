import type { Context } from "@steve.kite/stdlib";

import { inDatabase } from "../database/inDatabase.js";
import { and, eq, sql } from "drizzle-orm";
import { projectWorkspaces } from "../database/schema.js";
import { workspaceScope } from "./workspaceScope.js";

export async function workspaceCompleteArchive(
    ctx: Context,
    projectId: string,
    id: string,
    now: number,
): Promise<number> {
    return await inDatabase(ctx, "rig.sql.project.workspaceCompleteArchive", async (ctx) => {
        const tx = ctx.tx;
        return Number(
            (
                await tx
                    .update(projectWorkspaces)
                    .set({
                        archivedAtMs: now,
                        error: null,
                        status: "archived",
                        updatedAtMs: now,
                        version: sql`${projectWorkspaces.version} + 1`,
                    })
                    .where(
                        and(
                            workspaceScope(projectId, id),
                            eq(projectWorkspaces.status, "archiving"),
                        ),
                    )
                    .run()
            ).rowsAffected,
        );
    });
}
