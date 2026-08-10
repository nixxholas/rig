import type { Context } from "@steve.kite/stdlib";

import { inDatabase } from "../database/inDatabase.js";
import { asc, eq } from "drizzle-orm";

import type { Project } from "../../protocol/index.js";
import { projectAvatarAssets, projects } from "../database/schema.js";
import { projectReadRow } from "./impl/projectReadRow.js";

export async function queryProjects(ctx: Context): Promise<readonly Project[]> {
    return await inDatabase(ctx, "rig.sql.project.queryProjects", async (ctx) => {
        const tx = ctx.tx;
        return (
            await tx
                .select({ asset: projectAvatarAssets, project: projects })
                .from(projects)
                .leftJoin(projectAvatarAssets, eq(projectAvatarAssets.hash, projects.avatarHash))
                .orderBy(asc(projects.orderKey), asc(projects.id))
                .all()
        ).map((row) => projectReadRow(row.project, row.asset));
    });
}
