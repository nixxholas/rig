import { eq } from "drizzle-orm";

import type { Project } from "../../protocol/index.js";
import { projectAvatarAssets, projects } from "../database/schema.js";
import type { TX } from "../Transaction.js";
import { projectReadRow } from "./impl/projectReadRow.js";

export function queryProject(tx: TX, projectId: string): Project | undefined {
    const row = tx
        .select({ asset: projectAvatarAssets, project: projects })
        .from(projects)
        .leftJoin(projectAvatarAssets, eq(projectAvatarAssets.hash, projects.avatarHash))
        .where(eq(projects.id, projectId))
        .get();
    return row === undefined ? undefined : projectReadRow(row.project, row.asset);
}
