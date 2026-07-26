import type { Project, ProjectWorkspace } from "../protocol/index.js";
import type { GitTrackedEntity } from "./GitStateTracker.js";

/**
 * Describes a project or workspace to the tracker.
 *
 * A workspace carries the commit it was created from, so its snapshot measures the whole of its
 * work rather than only the working tree; a project has no such anchor and measures against HEAD.
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
        ...(workspace.baseCommit === undefined ? {} : { baseCommit: workspace.baseCommit }),
        path: workspace.path,
        projectId: workspace.projectId,
        workspaceId: workspace.id,
    };
}
