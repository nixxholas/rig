import { sql } from "drizzle-orm";

import { projectWorkspaces } from "../database/schema.js";
import type { TX } from "../Transaction.js";
import { workspaceScope } from "./workspaceScope.js";

/** Records the branch a workspace is actually on, after Git has moved it or refused to. */
export function workspaceSetBranch(
    tx: TX,
    projectId: string,
    id: string,
    branch: string,
    now: number,
): number {
    return Number(
        tx
            .update(projectWorkspaces)
            .set({
                branch,
                updatedAtMs: now,
                version: sql`${projectWorkspaces.version} + 1`,
            })
            .where(workspaceScope(projectId, id))
            .run().changes,
    );
}
