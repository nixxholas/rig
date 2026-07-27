import type { GroupDelta, GroupsState, ProjectGroup, WorkspaceGroup } from "./GroupElement.js";
import type { ConnectionState } from "./ChatElement.js";
import type {
    GitChangeSnapshot,
    GlobalEvent,
    GlobalStreamHello,
    Project,
    ProjectWorkspace,
    SessionStatus,
    SessionSummary,
} from "./protocol.js";

/**
 * Keeps the group catalog current from the global event stream.
 *
 * The daemon reports projects, workspaces, and sessions separately; this joins
 * them into one ordered tree and keeps that tree referentially stable, so a
 * React consumer re-renders only the branch that actually changed.
 */
export class GroupStore {
    #projects = new Map<string, Project>();
    #workspaces = new Map<string, ProjectWorkspace>();
    #sessions = new Map<string, SessionSummary>();
    /** Newest event applied per session, so an out-of-order copy is ignored. */
    #sessionEventIds = new Map<string, string>();
    #projectGit = new Map<string, GitChangeSnapshot>();
    #workspaceGit = new Map<string, GitChangeSnapshot>();
    /** Cached branch per project, reused whenever nothing under it changed. */
    #groups = new Map<string, ProjectGroup>();
    #workspaceGroups = new Map<string, WorkspaceGroup>();
    #dirty = new Set<string>();
    #tree: readonly ProjectGroup[] = [];
    #treeStale = true;
    #state: GroupsState = { connection: "connecting", sessionsComplete: true };

    projects(): readonly ProjectGroup[] {
        if (this.#treeStale) this.#rebuild();
        return this.#tree;
    }

    state(): GroupsState {
        return this.#state;
    }

    setConnection(connection: ConnectionState): readonly GroupDelta[] {
        if (this.#state.connection === connection) return [];
        this.#state = { ...this.#state, connection };
        return [{ state: this.#state, type: "groups_state_changed" }];
    }

    applyHello(hello: GlobalStreamHello): readonly GroupDelta[] {
        this.#projects.clear();
        this.#workspaces.clear();
        this.#sessions.clear();
        this.#sessionEventIds.clear();
        this.#groups.clear();
        this.#workspaceGroups.clear();
        this.#dirty.clear();
        // Git snapshots survive: they are live-only, so the stream replays them
        // after this frame and dropping them here would blank a branch a client
        // is already showing.
        for (const project of hello.projects) this.#projects.set(project.id, project);
        for (const workspace of hello.workspaces) this.#workspaces.set(workspace.id, workspace);
        for (const session of hello.sessions) this.#sessions.set(session.id, session);
        this.#treeStale = true;

        const deltas: GroupDelta[] = [];
        if (this.#state.sessionsComplete !== hello.sessionsComplete) {
            this.#state = { ...this.#state, sessionsComplete: hello.sessionsComplete };
            deltas.push({ state: this.#state, type: "groups_state_changed" });
        }
        deltas.push({ projects: this.projects(), type: "projects_changed" });
        return deltas;
    }

    apply(event: GlobalEvent): readonly GroupDelta[] {
        const deltas: GroupDelta[] = [];
        switch (event.type) {
            case "project_created":
            case "project_updated": {
                const { project } = event.data as { project: Project };
                const known = this.#projects.get(project.id);
                // Streams and snapshots race, so an older copy of an entity must
                // never overwrite a newer one already applied.
                if (known !== undefined && known.version > project.version) return [];
                this.#projects.set(project.id, project);
                this.#markDirty(project.id);
                if (known === undefined)
                    deltas.push({ projectId: project.id, type: "project_added" });
                break;
            }
            case "workspace_created":
            case "workspace_updated": {
                const { workspace } = event.data as { workspace: ProjectWorkspace };
                const known = this.#workspaces.get(workspace.id);
                if (known !== undefined && known.version > workspace.version) return [];
                this.#workspaces.set(workspace.id, workspace);
                this.#markDirty(workspace.projectId);
                if (known === undefined) {
                    deltas.push({
                        projectId: workspace.projectId,
                        type: "workspace_added",
                        workspaceId: workspace.id,
                    });
                }
                break;
            }
            case "project_git_changed": {
                const scope = event as { projectId: string; data: { git: GitChangeSnapshot } };
                if (!this.#acceptGit(this.#projectGit, scope.projectId, scope.data.git)) return [];
                this.#markDirty(scope.projectId);
                break;
            }
            case "workspace_git_changed": {
                const scope = event as {
                    projectId: string;
                    workspaceId?: string;
                    data: { git: GitChangeSnapshot };
                };
                const workspaceId = scope.workspaceId;
                if (workspaceId === undefined) return [];
                if (!this.#acceptGit(this.#workspaceGit, workspaceId, scope.data.git)) return [];
                this.#workspaceGroups.delete(workspaceId);
                this.#markDirty(scope.projectId);
                break;
            }
            default: {
                const applied = this.#applySessionEvent(event, deltas);
                if (!applied) return [];
                break;
            }
        }
        if (deltas.length === 0 && !this.#treeStale) return [];
        deltas.unshift({ projects: this.projects(), type: "projects_changed" });
        return deltas;
    }

    /**
     * Tracks the session catalog from the events that carry a whole session.
     *
     * Live events describe a session with `ProtocolSession` while the opening
     * frame uses `SessionSummary`. The two overlap but are not the same shape,
     * so each update is merged onto what is already known rather than replacing
     * it, and a field only the summary carries survives a live update.
     */
    #applySessionEvent(event: GlobalEvent, deltas: GroupDelta[]): boolean {
        const sessionId = (event as { sessionId?: string }).sessionId;
        if (sessionId === undefined) return false;
        // Events are ordered UUIDv7, so this is what decides which of two views
        // of the same session is newer. Sessions carry no version of their own.
        const seen = this.#sessionEventIds.get(sessionId);
        if (seen !== undefined && seen >= event.id) return false;

        if (event.type === "session_archived") {
            const { archived } = event.data as { archived: boolean };
            this.#sessionEventIds.set(sessionId, event.id);
            const known = this.#sessions.get(sessionId);
            if (known === undefined) return false;
            this.#sessions.set(sessionId, { ...known, archived });
            this.#markDirty(known.projectId);
            deltas.push({
                sessionId,
                type: archived ? "session_removed" : "session_added",
            });
            return true;
        }

        // A sidebar shows a session's name and whether it is working, and both
        // change through events that carry only the change rather than a whole
        // session. Applying them here is what keeps a list live without asking
        // the daemon to restate the session every time something moves.
        const patch = sessionPatch(event);
        if (patch !== undefined) {
            const known = this.#sessions.get(sessionId);
            if (known === undefined) return false;
            this.#sessionEventIds.set(sessionId, event.id);
            const updated = { ...known, ...patch.set };
            for (const key of patch.clear ?? []) delete updated[key];
            this.#sessions.set(sessionId, updated);
            this.#markDirty(known.projectId);
            return true;
        }

        if (event.type !== "session_created" && event.type !== "session_updated") return false;
        const incoming = (event.data as { session?: Partial<SessionSummary> }).session;
        if (incoming === undefined || typeof incoming.id !== "string") return false;
        this.#sessionEventIds.set(sessionId, event.id);

        const known = this.#sessions.get(incoming.id);
        const merged = { ...known, ...incoming } as SessionSummary;
        if (merged.projectId === undefined || merged.orderKey === undefined) return false;
        this.#sessions.set(merged.id, merged);
        this.#markDirty(merged.projectId);
        if (known !== undefined && known.projectId !== merged.projectId) {
            this.#markDirty(known.projectId);
        }
        if (known === undefined) deltas.push({ sessionId: merged.id, type: "session_added" });
        return true;
    }

    /**
     * Accepts a Git snapshot unless it is older than the one already held.
     *
     * Versions are monotonic within a daemon run, so a restart is the one case
     * where a lower version is newer and must be taken.
     */
    #acceptGit(into: Map<string, GitChangeSnapshot>, key: string, git: GitChangeSnapshot): boolean {
        const known = into.get(key);
        if (
            known !== undefined &&
            known.generation === git.generation &&
            known.version >= git.version
        ) {
            return false;
        }
        into.set(key, git);
        return true;
    }

    #markDirty(projectId: string): void {
        this.#dirty.add(projectId);
        this.#groups.delete(projectId);
        this.#treeStale = true;
    }

    #rebuild(): void {
        this.#treeStale = false;
        const sessionsByProject = new Map<string, SessionSummary[]>();
        const sessionsByWorkspace = new Map<string, SessionSummary[]>();
        for (const session of this.#sessions.values()) {
            if (session.archived) continue;
            const into =
                session.workspaceId === undefined
                    ? mapList(sessionsByProject, session.projectId)
                    : mapList(sessionsByWorkspace, session.workspaceId);
            into.push(session);
        }
        const workspacesByProject = new Map<string, ProjectWorkspace[]>();
        for (const workspace of this.#workspaces.values()) {
            if (isArchivedWorkspace(workspace)) continue;
            mapList(workspacesByProject, workspace.projectId).push(workspace);
        }

        const next: ProjectGroup[] = [];
        for (const project of [...this.#projects.values()].sort(byOrderKey)) {
            // An archived project is out of the catalog a client renders, along
            // with everything inside it.
            if (project.archivedAt !== undefined) continue;
            const cached = this.#groups.get(project.id);
            if (cached !== undefined && cached.project === project) {
                next.push(cached);
                continue;
            }
            const workspaces = (workspacesByProject.get(project.id) ?? [])
                .sort(byOrderKey)
                .map((workspace) => this.#workspaceGroup(workspace, sessionsByWorkspace));
            const group: ProjectGroup = {
                id: project.id,
                project,
                sessions: (sessionsByProject.get(project.id) ?? []).sort(byOrderKey),
                workspaces,
                ...(this.#projectGit.has(project.id)
                    ? { git: this.#projectGit.get(project.id) as GitChangeSnapshot }
                    : {}),
            };
            this.#groups.set(project.id, group);
            next.push(group);
        }
        this.#dirty.clear();
        this.#tree = next;
    }

    #workspaceGroup(
        workspace: ProjectWorkspace,
        sessionsByWorkspace: Map<string, SessionSummary[]>,
    ): WorkspaceGroup {
        const cached = this.#workspaceGroups.get(workspace.id);
        const sessions = (sessionsByWorkspace.get(workspace.id) ?? []).sort(byOrderKey);
        if (
            cached !== undefined &&
            cached.workspace === workspace &&
            sameSessions(cached.sessions, sessions)
        ) {
            return cached;
        }
        const group: WorkspaceGroup = {
            id: workspace.id,
            sessions,
            workspace,
            ...(this.#workspaceGit.has(workspace.id)
                ? { git: this.#workspaceGit.get(workspace.id) as GitChangeSnapshot }
                : {}),
        };
        this.#workspaceGroups.set(workspace.id, group);
        return group;
    }
}

function mapList<T>(into: Map<string, T[]>, key: string): T[] {
    const existing = into.get(key);
    if (existing !== undefined) return existing;
    const created: T[] = [];
    into.set(key, created);
    return created;
}

function byOrderKey(left: { orderKey: string }, right: { orderKey: string }): number {
    return left.orderKey < right.orderKey ? -1 : left.orderKey > right.orderKey ? 1 : 0;
}

/**
 * Whether two session lists hold the very same objects in the same order.
 *
 * Comparing ids alone would reuse a cached workspace after one of its sessions
 * was renamed or changed status, because the list looks unchanged by id while
 * the session it points at is a different object.
 */
function sameSessions(left: readonly SessionSummary[], right: readonly SessionSummary[]): boolean {
    if (left.length !== right.length) return false;
    return left.every((item, index) => item === right[index]);
}

function isArchivedWorkspace(workspace: ProjectWorkspace): boolean {
    return workspace.archivedAt !== undefined || workspace.status === "archived";
}

/**
 * The catalog-visible change an event describes, or `undefined` for one that
 * says nothing a session list renders.
 *
 * A run's status is derived rather than read: the events that start and end a
 * run say what happened, and a list only needs to know whether the session is
 * busy.
 */
function sessionPatch(event: GlobalEvent): SessionPatch | undefined {
    switch (event.type) {
        case "session_title_changed": {
            const { recap, title } = event.data as { recap?: string; title?: string };
            // The title and the recap both ride on this event and are both
            // cleared by omission, which is a different statement from setting
            // either to an empty string.
            const set: Partial<SessionSummary> = {};
            const clear: (keyof SessionSummary)[] = [];
            if (title === undefined) clear.push("title");
            else set.title = title;
            if (recap === undefined) clear.push("recap");
            else set.recap = recap;
            return { clear, set };
        }
        case "session_status_changed":
            // The daemon decides the lifecycle status and announces it. Deriving
            // one from run boundaries instead would disagree with the session
            // itself, which settles at "completed" rather than "idle", and would
            // say nothing about a suspended or interrupted session.
            return { set: { status: (event.data as { status: SessionStatus }).status } };
        default:
            return undefined;
    }
}

interface SessionPatch {
    set?: Partial<SessionSummary>;
    clear?: readonly (keyof SessionSummary)[];
}
