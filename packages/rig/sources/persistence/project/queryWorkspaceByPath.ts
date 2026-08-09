import { inDatabase } from "../database/inDatabase.js";
import { eq } from "drizzle-orm";

import type { ProjectWorkspace } from "../../protocol/index.js";
import { projectWorkspaces } from "../database/schema.js";
import type { DatabaseScope } from "../Transaction.js";
import { workspaceReadRow } from "./impl/workspaceReadRow.js";

export async function queryWorkspaceByPath(
    tx: DatabaseScope,
    path: string,
): Promise<ProjectWorkspace | undefined> {
    return await inDatabase(tx, async (tx) => {
        const row = await tx
            .select()
            .from(projectWorkspaces)
            .where(eq(projectWorkspaces.path, path))
            .get();
        return row === undefined ? undefined : workspaceReadRow(row);
    });
}
