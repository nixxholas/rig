import type { Context } from "@steve.kite/stdlib";

import { inDatabase } from "../database/inDatabase.js";
import { and, ne, sql } from "drizzle-orm";
import { projectWorkspaces } from "../database/schema.js";
import { workspaceScope } from "./workspaceScope.js";

export async function workspaceBeginArchive(
    ctx: Context,
    projectId: string,
    id: string,
    now: number,
    version?: number,
): Promise<number> {
    return await inDatabase(ctx, "rig.sql.project.workspaceBeginArchive", async (ctx) => {
        const tx = ctx.tx;
        return Number(
            (
                await tx
                    .update(projectWorkspaces)
                    .set({
                        error: null,
                        status: "archiving",
                        updatedAtMs: now,
                        version: sql`${projectWorkspaces.version} + 1`,
                    })
                    .where(
                        and(
                            workspaceScope(projectId, id, version),
                            ne(projectWorkspaces.status, "archived"),
                        ),
                    )
                    .run()
            ).rowsAffected,
        );
    });
}
