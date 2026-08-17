import type { Context } from "@steve.kite/stdlib";

import type { Workspace } from "./Workspace.js";
import type { WorkspaceAuthorization, WorkspaceAuthorizationAction } from "./WorkspaceStore.js";
import { isPromiseLike } from "./workspaceRuntime.js";

/**
 * Who may read or move another agent's workspace.
 *
 * An agent always reaches its own records. Anything else is a deny unless the host installed a
 * policy that allows this exact action, because a missing policy is an answer too.
 */
export async function authorizeWorkspaceAccess(
    ctx: Context,
    authorization: WorkspaceAuthorization | undefined,
    actingAgentId: string,
    ownerAgentId: string,
    action: WorkspaceAuthorizationAction,
): Promise<void> {
    if (actingAgentId === ownerAgentId) return;
    const refusal = new Error(
        `Agent "${actingAgentId}" is not authorized to ${action} workspace data owned by "${ownerAgentId}".`,
    );
    if (authorization === undefined) throw refusal;
    const raw = authorization(ctx, actingAgentId, ownerAgentId, action);
    const allowed = isPromiseLike(raw) ? await raw : raw;
    if (typeof allowed !== "boolean") {
        throw new Error("Workspace authorization returned an invalid result.");
    }
    if (!allowed) throw refusal;
}

export function assertWorkspaceOwner(agentId: string, workspace: Workspace): void {
    if (workspace.ownerAgentId !== agentId) {
        throw new Error(`Agent "${agentId}" is not the owner of workspace "${workspace.id}".`);
    }
}

/** Invariants the row itself must satisfy, whatever produced it. */
export function assertWorkspaceRecord(workspace: Workspace): void {
    if (workspace.updatedAt < workspace.createdAt) {
        throw new Error("Workspace timestamps are not ordered.");
    }
    if (workspace.archivedAt === undefined) {
        if (workspace.status === "archived") {
            throw new Error("Archived workspace is missing archivedAt.");
        }
        return;
    }
    if (workspace.status !== "archived" && workspace.status !== "archiving") {
        throw new Error("Non-archived workspace has archivedAt.");
    }
    if (workspace.archivedAt < workspace.createdAt || workspace.archivedAt > workspace.updatedAt) {
        throw new Error("Workspace archivedAt is inconsistent with its timestamps.");
    }
}
