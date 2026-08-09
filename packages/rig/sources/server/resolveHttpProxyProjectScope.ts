import type { ProjectScope } from "../protocol/index.js";
import type { SessionStore } from "../session/SessionStore.js";

export type HttpProxyProjectScopeResolution =
    | { allowed: true }
    | { allowed: false; message: string; statusCode: number; statusText: string };

export async function resolveHttpProxyProjectScope(
    scope: ProjectScope,
    store: SessionStore,
): Promise<HttpProxyProjectScopeResolution> {
    if ((await store.getProject(scope.projectId)) === undefined) {
        return {
            allowed: false,
            message: "The requested Rig project was not found.",
            statusCode: 404,
            statusText: "Not Found",
        };
    }
    if (
        scope.workspaceId !== undefined &&
        (await store.getWorkspace(scope.projectId, scope.workspaceId)) === undefined
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
