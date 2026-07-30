import { asc, eq } from "drizzle-orm";

import type { Project } from "../../protocol/index.js";
import { projectAvatarAssets, projects } from "../database/schema.js";
import type { TX } from "../Transaction.js";
import { projectReadRow } from "./impl/projectReadRow.js";

export function queryProjects(tx: TX): readonly Project[] {
    return tx
        .select({ asset: projectAvatarAssets, project: projects })
        .from(projects)
        .leftJoin(projectAvatarAssets, eq(projectAvatarAssets.hash, projects.avatarHash))
        .orderBy(asc(projects.orderKey), asc(projects.id))
        .all()
        .map((row) => projectReadRow(row.project, row.asset));
}
