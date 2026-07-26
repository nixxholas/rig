import type { EventId } from "./EventId.js";
import type { SessionEvent, SessionSummary } from "./SessionProtocol.js";

export type ProjectKind = "regular" | "home";
export type ProjectInitializationStatus = "initializing" | "ready" | "failed";
export type ProjectNameSource = "folder" | "git_remote" | "user";
export type ProjectAvatarSource = "repository" | "hosting" | "user";

/** Whether the directory backing a project or workspace still exists on disk. */
export type ProjectPresence = "present" | "missing";

/** Whether a managed workspace can be created from a project. */
export type ProjectWorktreeSupport = "supported" | "unsupported" | "unknown";

/** Slow-moving Git facts cached on a project or workspace row. */
export interface GitRepositoryFacts {
    ahead: number;
    behind: number;
    branch?: string;
    detached: boolean;
    head?: string;
    upstream?: string;
}

export type GitFileChangeStatus =
    | "added"
    | "conflicted"
    | "copied"
    | "deleted"
    | "modified"
    | "renamed"
    | "submodule"
    | "type_changed"
    | "untracked";

export interface GitFileChange {
    binary: boolean;
    /** Absent for binary files, submodule pointers, and files a cap left uncounted. */
    deletions?: number;
    insertions?: number;
    path: string;
    /** Original path of a rename or copy. */
    previousPath?: string;
    staged: boolean;
    status: GitFileChangeStatus;
    unstaged: boolean;
}

export type GitComparisonState = "ready" | "unavailable";

/** Everything a change snapshot reports, before the tracker stamps it with an identity. */
export interface GitChangeState {
    /** Commit the comparison is measured against. */
    base?: string;
    /** Total changed files, including any the list cap omitted. */
    changedFiles: number;
    comparison: GitComparisonState;
    /** True while a merge or rebase is unresolved, so a client can suppress a misleading total. */
    conflicted: boolean;
    /** False when any cap or failure prevented exact line counting. */
    countsExact: boolean;
    deletions: number;
    /** Human-readable explanation of a failed scan or an unavailable comparison. */
    error?: string;
    facts: GitRepositoryFacts;
    files: readonly GitFileChange[];
    filesTruncated: boolean;
    insertions: number;
    scannedAt: number;
}

export interface ProjectAvatar {
    hash: string;
    height: number;
    mediaType: "image/webp";
    source: ProjectAvatarSource;
    url: string;
    width: number;
}

export interface Project {
    archivedAt?: number;
    avatar?: ProjectAvatar;
    avatarBuiltin?: "home";
    createdAt: number;
    git?: GitRepositoryFacts;
    id: string;
    initializationAttempt: number;
    initializationError?: string;
    initializationStatus: ProjectInitializationStatus;
    kind: ProjectKind;
    name: string;
    nameSource: ProjectNameSource;
    orderKey: string;
    path: string;
    presence: ProjectPresence;
    storageKey: string;
    updatedAt: number;
    version: number;
    worktreeSupport: ProjectWorktreeSupport;
    /** Human-readable explanation, present only when worktreeSupport is "unsupported". */
    worktreeSupportReason?: string;
}

export type ProjectWorkspaceKind = "git_worktree";
export type ProjectWorkspaceStatus =
    | "initializing"
    | "ready"
    | "failed"
    | "archiving"
    | "archive_failed"
    | "archived";

export interface ProjectWorkspace {
    archivedAt?: number;
    /** Immutable commit the workspace was created from; the anchor for its comparison base. */
    baseCommit?: string;
    baseRef?: string;
    createdAt: number;
    error?: string;
    git?: GitRepositoryFacts;
    gitCommonDir: string;
    id: string;
    kind: ProjectWorkspaceKind;
    name: string;
    orderKey: string;
    path: string;
    presence: ProjectPresence;
    projectId: string;
    status: ProjectWorkspaceStatus;
    storageKey: string;
    updatedAt: number;
    version: number;
}

export interface CreateProjectWorkspaceRequest {
    baseRef: string;
    clientRequestId: string;
    name: string;
}

export interface ArchiveProjectWorkspaceRequest {
    clientRequestId: string;
}

export interface RenameProjectRequest {
    name: string;
}

export interface RenameProjectWorkspaceRequest {
    name: string;
}

export interface ReorderRequest {
    afterId: string | null;
}

export interface ListProjectsResponse {
    projects: readonly Project[];
}

export interface ProjectResponse {
    project: Project;
}

export interface ListProjectWorkspacesResponse {
    workspaces: readonly ProjectWorkspace[];
}

export interface ProjectWorkspaceResponse {
    workspace: ProjectWorkspace;
}

export interface GlobalStateResponse {
    cursor: string;
    hasMoreSessions: boolean;
    projects: readonly Project[];
    sessions: readonly SessionSummary[];
    sessionsNextCursor?: string;
    workspaces: readonly ProjectWorkspace[];
}

export interface BaseProjectEvent<TType extends string, TData> {
    createdAt: number;
    data: TData;
    id: EventId;
    projectId: string;
    type: TType;
}

export interface BaseProjectWorkspaceEvent<TType extends string, TData> {
    createdAt: number;
    data: TData;
    id: EventId;
    projectId: string;
    type: TType;
    workspaceId: string;
}

export type ProjectEvent =
    | BaseProjectEvent<"project_created", { project: Project }>
    | BaseProjectEvent<"project_updated", { project: Project }>;

export type ProjectWorkspaceEvent =
    | BaseProjectWorkspaceEvent<"workspace_created", { workspace: ProjectWorkspace }>
    | BaseProjectWorkspaceEvent<"workspace_updated", { workspace: ProjectWorkspace }>;

export type GlobalEvent = SessionEvent | ProjectEvent | ProjectWorkspaceEvent;

export interface GlobalEventQueueEntry {
    cursor: string;
    event: GlobalEvent;
}

export interface ListGlobalEventsResponse {
    events: readonly GlobalEventQueueEntry[];
}

export interface TrimGlobalEventsRequest {
    through: string;
}

export interface TrimGlobalEventsResponse {
    trimmed: number;
    through: string;
}
