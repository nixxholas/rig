import { and, eq } from "drizzle-orm";

import type { ProjectWorkspace } from "../../protocol/index.js";
import { projectWorkspaces } from "../database/schema.js";
import type { TX } from "../Transaction.js";
import { workspaceReadRow } from "./impl/workspaceReadRow.js";

export function queryWorkspaceByRequest(
    tx: TX,
    projectId: string,
    clientRequestId: string,
): ProjectWorkspace | undefined {
    const row = tx
        .select()
        .from(projectWorkspaces)
        .where(
            and(
                eq(projectWorkspaces.projectId, projectId),
                eq(projectWorkspaces.clientRequestId, clientRequestId),
            ),
        )
        .get();
    return row === undefined ? undefined : workspaceReadRow(row);
}
