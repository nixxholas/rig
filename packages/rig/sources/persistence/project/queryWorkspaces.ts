import { inDatabase } from "../database/inDatabase.js";
import { asc, eq, getTableColumns } from "drizzle-orm";

import type { ProjectWorkspace } from "../../protocol/index.js";
import { projects, projectWorkspaces } from "../database/schema.js";
import type { DatabaseScope } from "../Transaction.js";
import { workspaceReadRow } from "./impl/workspaceReadRow.js";

export async function queryWorkspaces(
    tx: DatabaseScope,
    projectId?: string,
): Promise<readonly ProjectWorkspace[]> {
    return await inDatabase(tx, async (tx) => {
        const rows =
            projectId === undefined
                ? await tx
                      .select({ ...getTableColumns(projectWorkspaces) })
                      .from(projectWorkspaces)
                      .innerJoin(projects, eq(projects.id, projectWorkspaces.projectId))
                      .orderBy(
                          asc(projects.orderKey),
                          asc(projectWorkspaces.orderKey),
                          asc(projectWorkspaces.id),
                      )
                      .all()
                : await tx
                      .select()
                      .from(projectWorkspaces)
                      .where(eq(projectWorkspaces.projectId, projectId))
                      .orderBy(asc(projectWorkspaces.orderKey), asc(projectWorkspaces.id))
                      .all();
        return rows.map(workspaceReadRow);
    });
}
