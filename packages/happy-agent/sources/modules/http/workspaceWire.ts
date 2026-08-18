import type { Workspace } from "@slopus/happy-agent-modules";

/**
 * The wire form of one workspace. The path and the branch are the recorded ones.
 *
 * Every route and the startup catalog answer with this same shape, so a client that opens with a
 * snapshot and one that lists a project's workspaces are looking at the same workspaces.
 */
export function workspaceWire(workspace: Workspace): Record<string, unknown> {
    return {
        archivedAt: workspace.archivedAt,
        baseCommit: workspace.baseCommit,
        baseRef: workspace.baseRef,
        branch: workspace.branch,
        createdAt: workspace.createdAt,
        creatorSessionId: workspace.creatorSessionId,
        git: {
            ahead: workspace.gitAhead,
            behind: workspace.gitBehind,
            branch: workspace.branch,
            detached: workspace.gitDetached,
            head: workspace.gitHead,
            upstream: workspace.gitUpstream,
        },
        gitCommonDir: workspace.gitCommonDir,
        id: workspace.id,
        initializationAttempt: workspace.initializationAttempt,
        initializationError: workspace.initializationError,
        kind: workspace.kind,
        name: workspace.name,
        nameConfigured: workspace.nameConfigured,
        orderKey: workspace.orderKey,
        path: workspace.path,
        presence: workspace.presence,
        projectId: workspace.projectRef,
        status: workspace.status,
        storageKey: workspace.storageKey,
        updatedAt: workspace.updatedAt,
        version: workspace.version,
    };
}
