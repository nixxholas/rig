import type { ConnectionState } from "./ChatElement.js";
import type { GitChangeSnapshot, SessionStatus, SessionTokenCount } from "./protocol.js";

export interface GroupUsage {
    readonly totalTokens: number;
}

/** One application-shaped session row in the catalog. */
export interface GroupSession {
    readonly archived: boolean;
    readonly createdAt: number;
    readonly cwd: string;
    readonly draft?: string;
    readonly draftUpdatedAt?: number;
    readonly effort?: string;
    readonly id: string;
    readonly lastMessageAt?: number;
    readonly modelId: string;
    readonly orderKey: string;
    readonly permissionMode: string;
    readonly projectId: string;
    readonly providerId: string;
    readonly recap?: string;
    readonly serviceTier?: string;
    readonly sessionTokenCount?: SessionTokenCount;
    readonly status: SessionStatus;
    readonly title?: string;
    readonly updatedAt: number;
    readonly workspaceId?: string;
}

/**
 * A project with everything it contains.
 *
 * The daemon reports projects, workspaces, and sessions as three flat lists that
 * every client then has to join. Doing it once here is the point of the library.
 */
export interface ProjectGroup {
    readonly id: string;
    readonly kind: "regular" | "home";
    readonly name: string;
    readonly orderKey: string;
    readonly path: string;
    readonly presence: "present" | "missing";
    readonly avatar?: {
        readonly height: number;
        readonly url: string;
        readonly width: number;
    };
    readonly usage: GroupUsage;
    /** Live Git state, present once the daemon is watching this project. */
    readonly git?: GitChangeSnapshot;
    /** Worktrees of this project, ordered. */
    readonly workspaces: readonly WorkspaceGroup[];
    /** Sessions belonging to the project itself rather than to a worktree. */
    readonly sessions: readonly GroupSession[];
}

export interface WorkspaceGroup {
    readonly id: string;
    readonly name: string;
    readonly orderKey: string;
    readonly path: string;
    readonly presence: "present" | "missing";
    readonly projectId: string;
    readonly status: "initializing" | "ready" | "failed" | "archiving" | "archive_failed";
    readonly title?: string;
    readonly usage: GroupUsage;
    readonly git?: GitChangeSnapshot;
    readonly sessions: readonly GroupSession[];
}

/** Live facts about the group catalog as a whole. */
export interface GroupsState {
    readonly connection: ConnectionState;
    /** True because the opening frame carries the complete active session catalog. */
    readonly sessionsComplete: boolean;
}

/** What changed, for a consumer that reacts rather than re-rendering. */
export type GroupDelta =
    | { type: "projects_changed"; projects: readonly ProjectGroup[] }
    | { type: "groups_state_changed"; state: GroupsState }
    | { type: "project_added"; projectId: string }
    | { type: "workspace_added"; projectId: string; workspaceId: string }
    | { type: "session_added"; sessionId: string }
    | { type: "session_removed"; sessionId: string };
