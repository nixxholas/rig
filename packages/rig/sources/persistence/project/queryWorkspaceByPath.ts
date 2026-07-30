import { eq } from "drizzle-orm";

import type { ProjectWorkspace } from "../../protocol/index.js";
import { projectWorkspaces } from "../database/schema.js";
import type { TX } from "../Transaction.js";
import { workspaceReadRow } from "./impl/workspaceReadRow.js";

export function queryWorkspaceByPath(tx: TX, path: string): ProjectWorkspace | undefined {
    const row = tx.select().from(projectWorkspaces).where(eq(projectWorkspaces.path, path)).get();
    return row === undefined ? undefined : workspaceReadRow(row);
}
