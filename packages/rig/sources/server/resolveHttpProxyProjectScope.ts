import type { ProjectScope } from "../protocol/index.js";
import type { ProjectRepository } from "../project/ProjectRepository.js";

export type HttpProxyProjectScopeResolution =
    | { allowed: true }
    | { allowed: false; message: string; statusCode: number; statusText: string };

export async function resolveHttpProxyProjectScope(
    ctx: Context,
    scope: ProjectScope,
    store: Pick<ProjectRepository, "getProject" | "getWorkspace">,
): Promise<HttpProxyProjectScopeResolution> {
    if ((await store.getProject(ctx, scope.projectId)) === undefined) {
        return {
            allowed: false,
            message: "The requested Rig project was not found.",
            statusCode: 404,
            statusText: "Not Found",
        };
    }
    if (
        scope.workspaceId !== undefined &&
        (await store.getWorkspace(ctx, scope.projectId, scope.workspaceId)) === undefined
    ) {
        return {
            allowed: false,
            message: "The requested Rig workspace was not found.",
            statusCode: 404,
            statusText: "Not Found",
        };
    }
    return { allowed: true };
}
import type { Context } from "@steve.kite/stdlib";
