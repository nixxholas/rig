import type { Project, ProjectWorkspace } from "../protocol/index.js";
import type { GitTrackedEntity } from "./GitStateTracker.js";

/**
 * Describes a project or workspace to the tracker.
 *
 * Projects and workspaces use the same branch comparison contract.
 */
export function resolveGitTrackedEntity(
    project: Project,
    workspace?: ProjectWorkspace,
): GitTrackedEntity | undefined {
    if (workspace === undefined) {
        if (project.presence !== "present") return undefined;
        return { path: project.path, projectId: project.id };
    }
    if (workspace.status !== "ready" || workspace.presence !== "present") return undefined;
    return {
        path: workspace.path,
        projectId: workspace.projectId,
        workspaceId: workspace.id,
    };
}
