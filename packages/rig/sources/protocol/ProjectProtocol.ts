import type { HappyPluginAppContribution } from "happy-plugins";

import type { EventId } from "./EventId.js";
import type {
    BaseSessionEvent,
    DaemonIdentity,
    ModelCatalog,
    SessionEvent,
    SessionSummary,
} from "./SessionProtocol.js";
import type { RemoteTerminalSummary } from "../terminal/types.js";
import type { SlotsChangedEvent } from "./SlotProtocol.js";
import type { WebappsChangedEvent } from "./WebappProtocol.js";

export type ProjectKind = "regular" | "home";
export type ProjectInitializationStatus = "initializing" | "ready" | "failed";
export type ProjectNameSource = "folder" | "git_remote" | "user";
export type ProjectAvatarSource = "repository" | "hosting" | "user";

/** A folder-backed operation targets either a project root or one workspace inside it. */
export interface ProjectScope {
    projectId: string;
    workspaceId?: string;
}

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
    /** Branch new workspaces are cut from, decided once when the project was added. */
    defaultBranch?: string;
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
export type ProjectWorkspaceStatus = "initializing" | "ready" | "failed" | "archiving" | "archived";

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
    /** Stable display title inherited once from the workspace's first chat. */
    title?: string;
    updatedAt: number;
    version: number;
}

export interface CreateProjectWorkspaceRequest {
    /** Explicit base to fork; the project's trunk on `origin` is used when it is absent. */
    baseRef?: string;
    /** Client-chosen cuid2 identity. Repeating it returns the same workspace. */
    id?: string;
    name: string;
}

export interface RenameProjectRequest {
    mutationId?: string;
    name: string;
}

export interface RenameProjectWorkspaceRequest {
    mutationId?: string;
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

export interface GitStateResponse {
    git: GitChangeSnapshot;
}

export interface ListProjectWorkspacesResponse {
    workspaces: readonly ProjectWorkspace[];
}

export interface ProjectWorkspaceResponse {
    workspace: ProjectWorkspace;
}

export interface GitWatchRequest {
    entities: readonly { projectId: string; workspaceId?: string }[];
}

export interface GitWatchResponse {
    snapshots: readonly GlobalLiveEvent[];
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
    | BaseProjectEvent<"project_created", { mutationId?: string; project: Project }>
    | BaseProjectEvent<"project_updated", { mutationId?: string; project: Project }>;

export type ProjectWorkspaceEvent =
    | BaseProjectWorkspaceEvent<
          "workspace_created",
          { mutationId?: string; workspace: ProjectWorkspace }
      >
    | BaseProjectWorkspaceEvent<
          "workspace_updated",
          { mutationId?: string; workspace: ProjectWorkspace }
      >;

/**
 * Git change snapshots, carrying the detail that is recomputed from disk on demand.
 *
 * These are live-only: delivered to current subscribers, never stored, and never advancing a
 * cursor. Persisting them would grow the durable log without adding recoverable information, since
 * one bounded scan reproduces them exactly. The durable half of Git state — branch, HEAD, upstream,
 * presence — rides on `project_updated` and `workspace_updated` instead.
 */
export type ProjectGitEvent = BaseProjectEvent<"project_git_changed", { git: GitChangeSnapshot }>;
export type ProjectWorkspaceGitEvent = BaseProjectWorkspaceEvent<
    "workspace_git_changed",
    { git: GitChangeSnapshot }
>;

export interface GitChangeSnapshot extends GitChangeState {
    /** Identity of the daemon run, so a client can tell a restart from an update. */
    generation: string;
    /** Monotonic within one generation; survives eviction so a client never regresses. */
    version: number;
}

export type RemoteTerminalsChangedEvent =
    | BaseProjectEvent<"remote_terminals_changed", { terminals: readonly RemoteTerminalSummary[] }>
    | BaseProjectWorkspaceEvent<
          "remote_terminals_changed",
          { terminals: readonly RemoteTerminalSummary[] }
      >;

export type SessionCurrentEvent = BaseSessionEvent<"session_current", { session: SessionSummary }>;

export interface RemoteTerminalGroupState {
    projectId: string;
    workspaceId?: string;
    terminals: readonly RemoteTerminalSummary[];
}

/** One presence state the user can be in. */
export interface PresenceSummary {
    /** How long a question may wait for an answer. `null` waits indefinitely, `0` never waits. */
    answerWaitMs: number | null;
    emoji: string;
    id: string;
    prompt: string;
    title: string;
}

/** Where the user is right now, and everything they can switch to. */
export interface PresenceSnapshot {
    /** When the current presence expires and the fallback takes over, when that is known. */
    changesAt?: number;
    fallbackPresenceId?: string;
    presence: PresenceSummary;
    presences: readonly PresenceSummary[];
    since: number;
}

/**
 * The user switched presence. It is live-only: presence says where the user is now, and a client
 * that reconnects reads the current state from the catalog rather than replaying old switches.
 */
export interface PresenceChangedEvent {
    createdAt: number;
    data: { presence: PresenceSnapshot };
    id: EventId;
    type: "presence_changed";
}

export interface SetPresenceRequestBody {
    fallbackPresenceId?: string;
    presenceId: string;
    /** Expiry in milliseconds since the epoch. Omitted keeps the presence until it is changed. */
    until?: number;
}

/** One plugin installed on this machine, as a client should show it. */
export interface PluginSummary {
    /** Running local MCP Apps, ordered exactly as a navigation host should present them. */
    apps: readonly HappyPluginAppContribution[];
    /** The folder the plugin writes to, which the user can open. */
    dataDirectory: string;
    description: string;
    /** Where Rig installed the plugin's code. */
    directory: string;
    folder: string;
    /** Why the current plugin generation is or is not available. */
    status: "build_failed" | "running" | "stopped";
    /** Present for a failed build or process failure. */
    error?: string;
    /** Whether a bounded current-run or build diagnostic is available. */
    logAvailable: boolean;
    name: string;
}

/** One bounded snapshot of the current plugin generation's output. */
export interface PluginLogSnapshot {
    /** Startup or exit reason when the current generation is unavailable. */
    error?: string;
    folder: string;
    name: string;
    source: "build" | "current_run";
    status: PluginSummary["status"];
    text: string;
    truncated: boolean;
    updatedAt: number;
}

export interface ListPluginsResponse {
    /** The live-stream position read immediately before this catalog was assembled. */
    cursor: EventId;
    failures: readonly { error: string; folder: string }[];
    plugins: readonly PluginSummary[];
    /** Ordered identity of the exact catalog state in this response. */
    version: EventId;
}

export interface PluginLogResponse {
    log: PluginLogSnapshot;
}

export interface InstalledPluginSummary {
    description: string;
    directory: string;
    folder: string;
    name: string;
}

export interface UninstalledPluginSummary {
    dataDirectory: string;
    folder: string;
    name: string;
}

export interface InstallPluginRequest {
    /** Absolute path on the machine running Rig. */
    sourceDirectory: string;
}

export interface InstallPluginResponse {
    plugin: InstalledPluginSummary;
}

export interface UninstallPluginResponse {
    plugin: UninstalledPluginSummary;
}

export type PluginManagementErrorCode =
    | "install_failed"
    | "invalid_request"
    | "plugin_not_found"
    | "plugins_unavailable"
    | "uninstall_failed";

export interface PluginManagementErrorResponse {
    error: {
        code: PluginManagementErrorCode;
        message: string;
    };
}

/**
 * The installed plugins changed, or one of them started or stopped. It is live-only and carries
 * the whole current set: plugins are folders on disk, so a client that reconnects reads them again
 * rather than replaying every past registration.
 */
export interface PluginsChangedEvent {
    createdAt: number;
    data: {
        failures: readonly { error: string; folder: string }[];
        plugins: readonly PluginSummary[];
        version: EventId;
    };
    id: EventId;
    type: "plugins_changed";
}

export type GlobalLiveEvent =
    | PluginsChangedEvent
    | PresenceChangedEvent
    | SlotsChangedEvent
    | WebappsChangedEvent
    | ProjectGitEvent
    | ProjectWorkspaceGitEvent
    | RemoteTerminalsChangedEvent
    | SessionCurrentEvent
    | Extract<SessionEvent, { type: "session_context_changed" | "session_draft_changed" }>;

export type GlobalEvent = SessionEvent | ProjectEvent | ProjectWorkspaceEvent | GlobalLiveEvent;

export interface GlobalEventQueueEntry {
    cursor: string;
    event: GlobalEvent;
}

/**
 * A live delivery. It carries no cursor, so a client's `Last-Event-Id` keeps pointing at the last
 * durable position and reconnecting never skips stored events.
 */
export interface GlobalLiveEventDelivery {
    event: GlobalLiveEvent;
    live: true;
}

export type GlobalEventDelivery = GlobalEventQueueEntry | GlobalLiveEventDelivery;

export function isLiveGlobalEvent(event: GlobalEvent): event is GlobalLiveEvent {
    return (
        event.type === "plugins_changed" ||
        event.type === "presence_changed" ||
        event.type === "slots_changed" ||
        event.type === "webapps_changed" ||
        event.type === "project_git_changed" ||
        event.type === "workspace_git_changed" ||
        event.type === "remote_terminals_changed" ||
        event.type === "session_current" ||
        event.type === "session_context_changed" ||
        event.type === "session_draft_changed"
    );
}

export interface ListGlobalEventsResponse {
    events: readonly GlobalEventQueueEntry[];
}

/**
 * The catalog snapshot a client loads from `GET /catalog`.
 *
 * It carries the group state a client needs to render immediately — the
 * projects, the workspaces inside them, and the sessions they contain — taken
 * at one point in the event stream, so a client can open the live stream first
 * and rebase this snapshot onto whatever arrived while it was loading.
 *
 * Git snapshots are deliberately absent. They are live-only, and a client
 * declares the entities it cares about with `POST /git/watch`, which answers
 * with their current snapshots.
 */
export interface GlobalStreamHello {
    /** The queue position this snapshot reflects; events after it follow on the stream. */
    cursor: string;
    catalog: ModelCatalog;
    identity: DaemonIdentity;
    /** Where the user is right now, and every presence they can switch to. */
    presence: PresenceSnapshot;
    protocolVersion: number;
    projects: readonly Project[];
    terminalGroups: readonly RemoteTerminalGroupState[];
    workspaces: readonly ProjectWorkspace[];
    sessions: readonly SessionSummary[];
    /** False when the daemon holds more sessions than this frame carried. */
    sessionsComplete: boolean;
}

export interface TrimGlobalEventsRequest {
    through: string;
}

export interface TrimGlobalEventsResponse {
    trimmed: number;
    through: string;
}
