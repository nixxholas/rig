import { and, asc, eq, sql } from "drizzle-orm";

import { projectWorkspaces } from "../database/schema.js";
import {
    projectNameKey,
    projectStorageKey,
    workspaceBranchName,
} from "../../project/projectIdentity.js";
import { generateKeyBetween } from "../../utils/fractionalIndexing.js";
import { inTx } from "../inTx.js";
import type { TX } from "../Transaction.js";
import { reserveUniqueBranch } from "./reserveUniqueBranch.js";
import { reserveUniqueWorkspaceName } from "./reserveUniqueWorkspaceName.js";
import type { ProjectCreator } from "../../protocol/index.js";

export interface WorkspaceReserveInput {
    baseCommit?: string;
    baseRef?: string;
    createdBy?: ProjectCreator;
    creatorSessionId?: string;
    gitCommonDir?: string;
    id: string;
    isBranchUnavailable?: (branch: string) => boolean;
    isStorageKeyUnavailable?: (storageKey: string) => boolean;
    name: string;
    nameConfigured?: boolean;
    now: number;
    pathForStorageKey: (storageKey: string) => string;
    projectId: string;
    /** Names both the storage key and the branch when Git's refs could not be read in full. */
    storageKeySeed?: string;
}

export function workspaceReserve(
    tx: TX,
    input: WorkspaceReserveInput,
): { created: boolean; workspaceId: string } {
    return inTx(tx, (tx) => {
        // The identity may already name this workspace, because a create is
        // repeated until it is known to have landed. It is the same workspace
        // only if it describes the same one.
        const retry = tx
            .select({
                baseRef: projectWorkspaces.baseRef,
                creatorInstanceId: projectWorkspaces.creatorInstanceId,
                creatorProfileId: projectWorkspaces.creatorProfileId,
                id: projectWorkspaces.id,
                projectId: projectWorkspaces.projectId,
            })
            .from(projectWorkspaces)
            .where(eq(projectWorkspaces.id, input.id))
            .get();
        if (retry !== undefined) {
            if (retry.projectId !== input.projectId) {
                throw new Error("That workspace ID already names a workspace in another project.");
            }
            if (input.baseRef !== undefined && retry.baseRef !== input.baseRef) {
                throw new Error(
                    "That workspace ID already names a workspace with a different base.",
                );
            }
            if (
                input.createdBy !== undefined &&
                (retry.creatorInstanceId !== input.createdBy.instanceId ||
                    retry.creatorProfileId !== input.createdBy.profileId)
            ) {
                throw new Error(
                    "That workspace ID already names a workspace owned by another human profile.",
                );
            }
            return { created: false, workspaceId: retry.id };
        }

        const name = reserveUniqueWorkspaceName(tx, {
            name: input.name,
            projectId: input.projectId,
        });
        const storageKey = reserveUniqueKey(
            input.storageKeySeed ?? projectStorageKey(input.name),
            (candidate) => {
                return (
                    input.isStorageKeyUnavailable?.(candidate) === true ||
                    tx
                        .select({ id: projectWorkspaces.id })
                        .from(projectWorkspaces)
                        .where(
                            and(
                                eq(projectWorkspaces.projectId, input.projectId),
                                sql`${projectWorkspaces.storageKey} = ${candidate} COLLATE NOCASE`,
                            ),
                        )
                        .get() !== undefined
                );
            },
        );
        // A seed carries the workspace's own ID, so an unreadable ref store cannot hide a branch
        // this reservation would otherwise collide with when the worktree is finally created.
        const branch = reserveUniqueBranch(tx, {
            branch: workspaceBranchName(input.storageKeySeed ?? name),
            ...(input.isBranchUnavailable === undefined
                ? {}
                : { isBranchUnavailable: input.isBranchUnavailable }),
            projectId: input.projectId,
        });
        const first = tx
            .select({ orderKey: projectWorkspaces.orderKey })
            .from(projectWorkspaces)
            .where(eq(projectWorkspaces.projectId, input.projectId))
            .orderBy(asc(projectWorkspaces.orderKey))
            .limit(1)
            .get();
        tx.insert(projectWorkspaces)
            .values({
                baseCommit: input.baseCommit ?? null,
                baseRef: input.baseRef ?? null,
                branch,
                creatorInstanceId: input.createdBy?.instanceId,
                creatorProfileId: input.createdBy?.profileId,
                creatorSessionId: input.creatorSessionId,
                createdAtMs: input.now,
                gitAhead: 0,
                gitBehind: 0,
                // Git discovery follows the durable reservation. Ready workspaces always replace
                // this sentinel with the resolved common directory before materialization.
                gitCommonDir: input.gitCommonDir ?? "",
                gitDetached: false,
                id: input.id,
                kind: "git_worktree",
                name,
                nameKey: projectNameKey(name),
                nameConfigured: input.nameConfigured ?? false,
                orderKey: generateKeyBetween(null, first?.orderKey ?? null),
                path: input.pathForStorageKey(storageKey),
                presence: "present",
                projectId: input.projectId,
                status: "initializing",
                storageKey,
                updatedAtMs: input.now,
                version: 1,
            })
            .run();
        return { created: true, workspaceId: input.id };
    });
}

function reserveUniqueKey(base: string, taken: (candidate: string) => boolean): string {
    if (!taken(base)) return base;
    for (let suffix = 2; ; suffix += 1) {
        const candidate = `${base}-${String(suffix)}`;
        if (!taken(candidate)) return candidate;
    }
}
