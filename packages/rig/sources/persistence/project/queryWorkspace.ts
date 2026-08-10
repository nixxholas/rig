import type { Context } from "@steve.kite/stdlib";

import { inDatabase } from "../database/inDatabase.js";
import { and, eq } from "drizzle-orm";

import type { ProjectWorkspace } from "../../protocol/index.js";
import { projectWorkspaces } from "../database/schema.js";
import { workspaceReadRow } from "./impl/workspaceReadRow.js";

export async function queryWorkspace(
    ctx: Context,
    projectId: string,
    workspaceId: string,
): Promise<ProjectWorkspace | undefined> {
    return await inDatabase(ctx, "rig.sql.project.queryWorkspace", async (ctx) => {
        const tx = ctx.tx;
        const row = await tx
            .select()
            .from(projectWorkspaces)
            .where(
                and(
                    eq(projectWorkspaces.id, workspaceId),
                    eq(projectWorkspaces.projectId, projectId),
                ),
            )
            .get();
        return row === undefined ? undefined : workspaceReadRow(row);
    });
}
