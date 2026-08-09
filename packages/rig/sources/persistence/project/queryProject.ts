import { inDatabase } from "../database/inDatabase.js";
import { eq } from "drizzle-orm";

import type { Project } from "../../protocol/index.js";
import { projectAvatarAssets, projects } from "../database/schema.js";
import type { DatabaseScope } from "../Transaction.js";
import { projectReadRow } from "./impl/projectReadRow.js";

export async function queryProject(
    tx: DatabaseScope,
    projectId: string,
): Promise<Project | undefined> {
    return await inDatabase(tx, async (tx) => {
        const row = await tx
            .select({ asset: projectAvatarAssets, project: projects })
            .from(projects)
            .leftJoin(projectAvatarAssets, eq(projectAvatarAssets.hash, projects.avatarHash))
            .where(eq(projects.id, projectId))
            .get();
        return row === undefined ? undefined : projectReadRow(row.project, row.asset);
    });
}
