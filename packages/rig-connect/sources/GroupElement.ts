import type { ConnectionState } from "./ChatElement.js";
import type { GitChangeSnapshot, Project, ProjectWorkspace, SessionSummary } from "./protocol.js";

/**
 * A project with everything it contains.
 *
 * The daemon reports projects, workspaces, and sessions as three flat lists that
 * every client then has to join. Doing it once here is the point of the library.
 */
export interface ProjectGroup {
    readonly id: string;
    readonly project: Project;
    /** Live Git state, present once the daemon is watching this project. */
    readonly git?: GitChangeSnapshot;
    /** Worktrees of this project, ordered. */
    readonly workspaces: readonly WorkspaceGroup[];
    /** Sessions belonging to the project itself rather than to a worktree. */
    readonly sessions: readonly SessionSummary[];
}

export interface WorkspaceGroup {
    readonly id: string;
    readonly workspace: ProjectWorkspace;
    readonly git?: GitChangeSnapshot;
    readonly sessions: readonly SessionSummary[];
}

/** Live facts about the group catalog as a whole. */
export interface GroupsState {
    readonly connection: ConnectionState;
    /**
     * False when the daemon holds more sessions than the opening frame carried.
     * A client that wants the rest asks for them; the common case does not.
     */
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
