import type { Context } from "@steve.kite/stdlib";

import { inDatabase } from "../database/inDatabase.js";
import { eq } from "drizzle-orm";

import type { ProjectWorkspace } from "../../protocol/index.js";
import { projectWorkspaces } from "../database/schema.js";
import { workspaceReadRow } from "./impl/workspaceReadRow.js";

export async function queryWorkspaceByPath(
    ctx: Context,
    path: string,
): Promise<ProjectWorkspace | undefined> {
    return await inDatabase(ctx, "rig.sql.project.queryWorkspaceByPath", async (ctx) => {
        const tx = ctx.tx;
        const row = await tx
            .select()
            .from(projectWorkspaces)
            .where(eq(projectWorkspaces.path, path))
            .get();
        return row === undefined ? undefined : workspaceReadRow(row);
    });
}
