import type { Context } from "@steve.kite/stdlib";

import { sql } from "drizzle-orm";

import { projectWorkspaces } from "../database/schema.js";
import { projectNameKey, workspaceBranchName } from "../../project/projectIdentity.js";
import { inTx } from "../inTx.js";
import { reserveUniqueBranch } from "./reserveUniqueBranch.js";
import { reserveUniqueWorkspaceName } from "./reserveUniqueWorkspaceName.js";
import { workspaceScope } from "./workspaceScope.js";

export interface WorkspaceRenameResult {
    /** Branch the workspace should be on once Git has caught up with the new name. */
    branch: string;
    changed: number;
    name: string;
}

/**
 * Renames a workspace on a person's behalf and moves its branch with the name.
 *
 * The name is the only name a workspace has, so this also records that a person chose it: a
 * workspace someone has named is never renamed again by its first chat.
 */
export async function workspaceRename(
    ctx: Context,
    input: {
        id: string;
        isBranchUnavailable?: (branch: string) => boolean;
        name: string;
        now: number;
        projectId: string;
        version?: number;
    },
): Promise<WorkspaceRenameResult> {
    return await inTx(ctx, "rig.sql.project.workspaceRename", async (ctx) => {
        const tx = ctx.tx;
        const name = await reserveUniqueWorkspaceName(ctx, {
            excludeWorkspaceId: input.id,
            name: input.name,
            projectId: input.projectId,
        });
        const branch = await reserveUniqueBranch(ctx, {
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
                        nameConfigured: true,
                        updatedAtMs: input.now,
                        version: sql`${projectWorkspaces.version} + 1`,
                    })
                    .where(workspaceScope(input.projectId, input.id, input.version))
                    .run()
            ).rowsAffected,
        );
        return { branch, changed, name };
    });
}
