import { and, eq, sql } from "drizzle-orm";

import { projectWorkspaces } from "../database/schema.js";
import { projectNameKey, workspaceBranchName } from "../../project/projectIdentity.js";
import { inTx } from "../inTx.js";
import type { DatabaseScope } from "../Transaction.js";
import { reserveUniqueBranch } from "./reserveUniqueBranch.js";
import { reserveUniqueWorkspaceName } from "./reserveUniqueWorkspaceName.js";
import { workspaceScope } from "./workspaceScope.js";

export interface WorkspaceInheritNameResult {
    /** Branch the workspace should be on once Git has caught up; absent when nothing changed. */
    branch?: string;
    changed: number;
}

/**
 * Gives a workspace the name its first chat arrived at, and moves its branch with it.
 *
 * Only a workspace created with a placeholder name is named this way. `name_configured` says the
 * name was already chosen deliberately — by the person, or by the agent that asked for the
 * workspace — and it makes this a no-op rather than a correction.
 */
export async function workspaceInheritName(
    tx: DatabaseScope,
    input: {
        id: string;
        isBranchUnavailable?: (branch: string) => boolean;
        name: string;
        now: number;
        projectId: string;
    },
): Promise<WorkspaceInheritNameResult> {
    return await inTx(tx, async (tx) => {
        const name = await reserveUniqueWorkspaceName(tx, {
            excludeWorkspaceId: input.id,
            name: input.name,
            projectId: input.projectId,
        });
        const branch = await reserveUniqueBranch(tx, {
            branch: workspaceBranchName(name),
            excludeWorkspaceId: input.id,
            ...(input.isBranchUnavailable === undefined
                ? {}
                : { isBranchUnavailable: input.isBranchUnavailable }),
            projectId: input.projectId,
        });
        const changed = Number(
            (
                await tx
                    .update(projectWorkspaces)
                    .set({
                        branch,
                        name,
                        nameKey: projectNameKey(name),
                        updatedAtMs: input.now,
                        version: sql`${projectWorkspaces.version} + 1`,
                    })
                    .where(
                        and(
                            workspaceScope(input.projectId, input.id),
                            eq(projectWorkspaces.nameConfigured, false),
                        ),
                    )
                    .run()
            ).rowsAffected,
        );
        return { ...(changed === 0 ? {} : { branch }), changed };
    });
}
