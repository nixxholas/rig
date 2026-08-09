import { inDatabase } from "../database/inDatabase.js";
import { and, eq, sql } from "drizzle-orm";

import { projectWorkspaces } from "../database/schema.js";
import type { DatabaseScope } from "../Transaction.js";
import { workspaceScope } from "./workspaceScope.js";

export interface WorkspaceInitializationFacts {
    baseCommit: string;
    baseRef: string;
    gitCommonDir: string;
}

/**
 * Records the Git facts resolved after a workspace reservation became visible.
 *
 * All three facts describe one base decision, so they land together or not at all. A workspace
 * archived or failed while discovery was running keeps its terminal state and ignores the late
 * result.
 */
export async function workspaceRecordInitialization(
    tx: DatabaseScope,
    projectId: string,
    id: string,
    facts: WorkspaceInitializationFacts,
    now: number,
): Promise<number> {
    return await inDatabase(tx, async (tx) => {
        return Number(
            (
                await tx
                    .update(projectWorkspaces)
                    .set({
                        baseCommit: facts.baseCommit,
                        baseRef: facts.baseRef,
                        gitCommonDir: facts.gitCommonDir,
                        updatedAtMs: now,
                        version: sql`${projectWorkspaces.version} + 1`,
                    })
                    .where(
                        and(
                            workspaceScope(projectId, id),
                            eq(projectWorkspaces.status, "initializing"),
                        ),
                    )
                    .run()
            ).rowsAffected,
        );
    });
}
