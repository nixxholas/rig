import type { GitRepositoryFacts, ProjectWorkspace } from "../../../protocol/index.js";
import type { projectWorkspaces } from "../../database/schema.js";

type WorkspaceRow = typeof projectWorkspaces.$inferSelect;

export function workspaceReadRow(row: WorkspaceRow): ProjectWorkspace {
    const git = workspaceReadGitFacts(row);
    return {
        ...(row.archivedAtMs === null ? {} : { archivedAt: row.archivedAtMs }),
        ...(row.baseCommit === null ? {} : { baseCommit: row.baseCommit }),
        ...(row.baseRef === null ? {} : { baseRef: row.baseRef }),
        branch: row.branch,
        createdAt: row.createdAtMs,
        ...(row.error === null ? {} : { error: row.error }),
        ...(git === undefined ? {} : { git }),
        gitCommonDir: row.gitCommonDir,
        id: row.id,
        kind: row.kind as ProjectWorkspace["kind"],
        name: row.name,
        orderKey: row.orderKey,
        path: row.path,
        presence: row.presence as ProjectWorkspace["presence"],
        projectId: row.projectId,
        status: row.status as ProjectWorkspace["status"],
        storageKey: row.storageKey,
        updatedAt: row.updatedAtMs,
        version: row.version,
    };
}

function workspaceReadGitFacts(row: WorkspaceRow): GitRepositoryFacts | undefined {
    const branch = row.gitBranch ?? undefined;
    const head = row.gitHead ?? undefined;
    const upstream = row.gitUpstream ?? undefined;
    if (branch === undefined && head === undefined && !row.gitDetached) return undefined;
    return {
        ahead: row.gitAhead,
        behind: row.gitBehind,
        ...(branch === undefined ? {} : { branch }),
        detached: row.gitDetached,
        ...(head === undefined ? {} : { head }),
        ...(upstream === undefined ? {} : { upstream }),
    };
}
