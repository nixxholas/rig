/** Projects: a folder registered with the daemon, or a repository it cloned. */

import type {
    Compute,
    ComputeSelection,
    Cuid2,
    GitSummary,
    InitializationState,
    ResourceVersion,
    Timestamp,
} from "./common.js";

/** Where a cloned project came from; `null` for a registered local folder. */
export type RemoteSource =
    | { kind: "github"; repository: string }
    | { kind: "git"; url: string };

/**
 * The project picture.
 *
 * The built-in home project — the user's machine outside any repository —
 * carries `{ kind: "home" }` and has no image bytes to fetch.
 */
export type ProjectAvatar =
    | { kind: "image"; thumbhash: string; source: "user" | "generated" }
    | { kind: "home" };

export interface ProjectSettings {
    /** Where new workspaces of this project run. */
    defaultWorkspaceCompute: ComputeSelection;
}

/** The project object. A project is also the root workspace of its tree. */
export interface Project {
    id: Cuid2;
    name: string;
    /** Where the name came from; a user-chosen name is never derived over. */
    nameSource: "folder" | "user";
    compute: Compute;
    status: "active" | "archived";
    initialization: InitializationState;
    /** `null` when the folder is not a Git repository. */
    git: GitSummary | null;
    defaultBranch: string | null;
    /** Whether child workspaces can be created as Git worktrees. */
    worktreeSupport: "supported" | "unsupported" | "unknown";
    /** Accompanies `worktreeSupport` of `"unsupported"`. */
    worktreeUnsupportedReason?: string;
    remoteSource: RemoteSource | null;
    avatar: ProjectAvatar | null;
    description: string | null;
    settings: ProjectSettings;
    /** An opaque sort key; clients order projects by comparing these strings. */
    orderKey: string;
    version: ResourceVersion;
    createdAt: Timestamp;
    updatedAt: Timestamp;
    archivedAt: Timestamp | null;
}

/** `GET /v0/projects` */
export interface ProjectListResponse {
    projects: Project[];
}

/** Every single-project route answers with this. */
export interface ProjectResponse {
    project: Project;
}

/** `PUT /v0/projects/:projectId/settings` */
export interface ProjectSettingsResponse {
    project: Project;
    settings: ProjectSettings;
}

/** `POST /v0/projects` — registers an existing local folder. */
export interface RegisterProjectRequest {
    /** The folder to register. Must exist and be a directory. */
    path: string;
    /** Optional client-supplied ID, for callers that need it before the answer. */
    projectId?: Cuid2;
}

/** `POST /v0/projects/clone` */
export interface CloneProjectRequest {
    /** The folder name for the clone. */
    name: string;
    source: RemoteSource;
    /** Names the stored credential kind to clone with. */
    secret?: { kind: "github" };
    projectId?: Cuid2;
}

/** `PATCH /v0/projects/:projectId` */
export interface RenameProjectRequest {
    name: string;
    mutationId?: string;
}

/** `PUT /v0/projects/:projectId/settings` */
export interface ReplaceProjectSettingsRequest extends ProjectSettings {
    mutationId?: string;
}

/** `POST /v0/projects/:projectId/reorder` */
export interface ReorderProjectRequest {
    /** The project to place this one after, or `null` to move it first. */
    afterId: Cuid2 | null;
    mutationId?: string;
}

/** `POST /v0/projects/:projectId/archive` */
export interface ArchiveProjectRequest {
    mutationId?: string;
}
