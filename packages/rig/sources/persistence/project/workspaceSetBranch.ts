import { inDatabase } from "../database/inDatabase.js";
import { sql } from "drizzle-orm";

import { projectWorkspaces } from "../database/schema.js";
import type { DatabaseScope } from "../Transaction.js";
import { workspaceScope } from "./workspaceScope.js";

/** Records the branch a workspace is actually on, after Git has moved it or refused to. */
export async function workspaceSetBranch(
    tx: DatabaseScope,
    projectId: string,
    id: string,
    branch: string,
    now: number,
): Promise<number> {
    return await inDatabase(tx, async (tx) => {
        return Number(
            (
                await tx
                    .update(projectWorkspaces)
                    .set({
                        branch,
                        updatedAtMs: now,
                        version: sql`${projectWorkspaces.version} + 1`,
                    })
                    .where(workspaceScope(projectId, id))
                    .run()
            ).rowsAffected,
        );
    });
}
