import { inDatabase } from "../database/inDatabase.js";
import { eq } from "drizzle-orm";

import type { ProjectWorkspace } from "../../protocol/index.js";
import { projectWorkspaces } from "../database/schema.js";
import type { DatabaseScope } from "../Transaction.js";
import { workspaceReadRow } from "./impl/workspaceReadRow.js";

/** Reads a workspace by identity alone, without assuming which project owns it. */
export async function queryWorkspaceById(
    tx: DatabaseScope,
    workspaceId: string,
): Promise<ProjectWorkspace | undefined> {
    return await inDatabase(tx, async (tx) => {
        const row = await tx
            .select()
            .from(projectWorkspaces)
            .where(eq(projectWorkspaces.id, workspaceId))
            .get();
        return row === undefined ? undefined : workspaceReadRow(row);
    });
}
