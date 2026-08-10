import type { Context } from "@steve.kite/stdlib";

import { inDatabase } from "../database/inDatabase.js";
import { eq } from "drizzle-orm";

import type { Project } from "../../protocol/index.js";
import { projectAvatarAssets, projects } from "../database/schema.js";
import { projectReadRow } from "./impl/projectReadRow.js";

export async function queryProject(ctx: Context, projectId: string): Promise<Project | undefined> {
    return await inDatabase(ctx, "rig.sql.project.queryProject", async (ctx) => {
        const tx = ctx.tx;
        const row = await tx
            .select({ asset: projectAvatarAssets, project: projects })
            .from(projects)
            .leftJoin(projectAvatarAssets, eq(projectAvatarAssets.hash, projects.avatarHash))
            .where(eq(projects.id, projectId))
            .get();
        return row === undefined ? undefined : projectReadRow(row.project, row.asset);
    });
}
