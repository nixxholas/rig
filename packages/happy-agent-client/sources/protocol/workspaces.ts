/** Workspaces: a checkout with its own folder, its own branch, and its place in a tree. */

import type {
    Compute,
    Cuid2,
    GitSummary,
    InitializationState,
    ResourceVersion,
    Timestamp,
} from "./common.js";

/** What the workspace was created from. */
export interface WorkspaceBase {
    /** The ref the caller named. */
    ref: string;
    /** The commit that ref resolved to at creation time. */
    commit: string;
}

/** The workspace object. A project's root workspace shares the project's ID. */
export interface Workspace {
    id: Cuid2;
    /** The root of this workspace's tree. */
    projectId: Cuid2;
    /** `null` on the root workspace. */
    parentId: Cuid2 | null;
    /** The display name, which is also the branch name behind the checkout. */
    name: string;
    nameSource: "user" | "generated";
    /** How the checkout was made. */
    kind: "root" | "worktree" | "copy";
    compute: Compute;
    /** `"archiving"` is the window where the decision is durable but cleanup runs. */
    status: "active" | "archiving" | "archived";
    initialization: InitializationState;
    /** `null` on a root workspace, which was not branched from anything. */
    base: WorkspaceBase | null;
    git: GitSummary | null;
    /** The agent that created this workspace; `null` when a person did. */
    creatorAgentId: Cuid2 | null;
    /** Orders this workspace among the siblings sharing its parent. */
    orderKey: string;
    version: ResourceVersion;
    createdAt: Timestamp;
    updatedAt: Timestamp;
    archivedAt: Timestamp | null;
}

/** `GET /v0/workspaces` — a flat array; clients build the tree from `parentId`. */
export interface WorkspaceListResponse {
    workspaces: Workspace[];
}

/** Every single-workspace route answers with this. */
export interface WorkspaceResponse {
    workspace: Workspace;
}

/** `GET /v0/workspaces` query parameters. */
export interface ListWorkspacesQuery {
    /** Only this project's tree. */
    projectId?: Cuid2;
    /** Archived and archiving workspaces are history; default `false`. */
    includeArchived?: boolean;
}

/** `POST /v0/workspaces` */
export interface CreateWorkspaceRequest {
    /** The workspace to nest under: a root workspace or any workspace in a tree. */
    parentId: Cuid2;
    /** The workspace name, which is also its branch name. */
    name?: string;
    /** The ref to branch from; defaults to the parent's current branch. */
    baseRef?: string;
    /** Optional client-supplied ID. */
    id?: Cuid2;
    /** Records the creating agent as `creatorAgentId`. */
    agentId?: Cuid2;
    mutationId?: string;
}

/** `PATCH /v0/workspaces/:workspaceId` */
export interface RenameWorkspaceRequest {
    name: string;
    mutationId?: string;
}

/** `POST /v0/workspaces/:workspaceId/archive` */
export interface ArchiveWorkspaceRequest {
    mutationId?: string;
}

/** `POST /v0/workspaces/:workspaceId/reorder` */
export interface ReorderWorkspaceRequest {
    /** The sibling to place this one after, or `null` to move it first. */
    afterId: Cuid2 | null;
    mutationId?: string;
}
