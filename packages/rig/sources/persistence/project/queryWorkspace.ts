import { and, eq } from "drizzle-orm";

import type { ProjectWorkspace } from "../../protocol/index.js";
import { projectWorkspaces } from "../database/schema.js";
import type { TX } from "../Transaction.js";
import { workspaceReadRow } from "./impl/workspaceReadRow.js";

export function queryWorkspace(
    tx: TX,
    projectId: string,
    workspaceId: string,
): ProjectWorkspace | undefined {
    const row = tx
        .select()
        .from(projectWorkspaces)
        .where(
            and(eq(projectWorkspaces.id, workspaceId), eq(projectWorkspaces.projectId, projectId)),
        )
        .get();
    return row === undefined ? undefined : workspaceReadRow(row);
}
