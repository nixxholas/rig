import type { Context } from "@steve.kite/stdlib";

import type { ProjectAuthorization, ProjectAuthorizationAction } from "./ProjectStore.js";
import { isPromiseLike } from "./projectRuntime.js";

/**
 * Who may read or change another agent's project.
 *
 * An agent always reaches its own records. Anything else is a deny unless the host installed a
 * policy that allows this exact action, because a missing policy is an answer too.
 */
export async function authorizeProjectAccess(
    ctx: Context,
    authorization: ProjectAuthorization | undefined,
    actingAgentId: string,
    ownerAgentId: string,
    action: ProjectAuthorizationAction,
): Promise<void> {
    if (actingAgentId === ownerAgentId) return;
    const refusal = new Error(
        `Agent "${actingAgentId}" is not authorized to ${action} project data owned by "${ownerAgentId}".`,
    );
    if (authorization === undefined) throw refusal;
    const raw = authorization(ctx, actingAgentId, ownerAgentId, action);
    const allowed = isPromiseLike(raw) ? await raw : raw;
    if (typeof allowed !== "boolean") {
        throw new Error("Project authorization returned an invalid result.");
    }
    if (!allowed) throw refusal;
}
