import { inDatabase } from "../database/inDatabase.js";
import { asc, eq } from "drizzle-orm";

import type { Project } from "../../protocol/index.js";
import { projectAvatarAssets, projects } from "../database/schema.js";
import type { DatabaseScope } from "../Transaction.js";
import { projectReadRow } from "./impl/projectReadRow.js";

export async function queryProjects(tx: DatabaseScope): Promise<readonly Project[]> {
    return await inDatabase(tx, async (tx) => {
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
