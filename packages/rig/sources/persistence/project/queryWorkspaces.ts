import { asc, eq, getTableColumns } from "drizzle-orm";

import type { ProjectWorkspace } from "../../protocol/index.js";
import { projects, projectWorkspaces } from "../database/schema.js";
import type { TX } from "../Transaction.js";
import { workspaceReadRow } from "./impl/workspaceReadRow.js";

export function queryWorkspaces(tx: TX, projectId?: string): readonly ProjectWorkspace[] {
    const rows =
        projectId === undefined
            ? tx
                  .select({ ...getTableColumns(projectWorkspaces) })
                  .from(projectWorkspaces)
                  .innerJoin(projects, eq(projects.id, projectWorkspaces.projectId))
                  .orderBy(
                      asc(projects.orderKey),
                      asc(projectWorkspaces.orderKey),
                      asc(projectWorkspaces.id),
                  )
                  .all()
            : tx
                  .select()
                  .from(projectWorkspaces)
                  .where(eq(projectWorkspaces.projectId, projectId))
                  .orderBy(asc(projectWorkspaces.orderKey), asc(projectWorkspaces.id))
                  .all();
    return rows.map(workspaceReadRow);
}
