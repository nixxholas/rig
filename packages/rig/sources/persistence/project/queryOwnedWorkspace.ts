import { inDatabase } from "../database/inDatabase.js";
import { and, eq } from "drizzle-orm";

import type { ProjectWorkspace } from "../../protocol/index.js";
import { projectWorkspaces } from "../database/schema.js";
import type { DatabaseScope } from "../Transaction.js";
import { workspaceReadRow } from "./impl/workspaceReadRow.js";

export async function queryOwnedWorkspace(
    tx: DatabaseScope,
    creatorSessionId: string,
    projectId: string,
    workspaceId: string,
): Promise<ProjectWorkspace | undefined> {
    return await inDatabase(tx, async (tx) => {
        const row = await tx
            .select()
            .from(projectWorkspaces)
            .where(
                and(
                    eq(projectWorkspaces.id, workspaceId),
                    eq(projectWorkspaces.projectId, projectId),
                    eq(projectWorkspaces.creatorSessionId, creatorSessionId),
                ),
            )
            .get();
        return row === undefined ? undefined : workspaceReadRow(row);
    });
}
