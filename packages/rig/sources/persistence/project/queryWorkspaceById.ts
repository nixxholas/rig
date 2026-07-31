import { eq } from "drizzle-orm";

import type { ProjectWorkspace } from "../../protocol/index.js";
import { projectWorkspaces } from "../database/schema.js";
import type { TX } from "../Transaction.js";
import { workspaceReadRow } from "./impl/workspaceReadRow.js";

/** Reads a workspace by identity alone, without assuming which project owns it. */
export function queryWorkspaceById(tx: TX, workspaceId: string): ProjectWorkspace | undefined {
    const row = tx
        .select()
        .from(projectWorkspaces)
        .where(eq(projectWorkspaces.id, workspaceId))
        .get();
    return row === undefined ? undefined : workspaceReadRow(row);
}
