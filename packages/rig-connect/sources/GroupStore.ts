import type {
    GroupDelta,
    GroupSession,
    GroupsState,
    ProjectGroup,
    WorkspaceGroup,
} from "./GroupElement.js";
import type { ConnectionState } from "./ChatElement.js";
import type {
    GitChangeSnapshot,
    GlobalEvent,
    GlobalStreamHello,
    Project,
    ProjectWorkspace,
    SessionStatus,
    SessionSummary,
    SessionTokenCount,
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
    #workspaceGroupSources = new Map<string, ProjectWorkspace>();
    #groupSessions = new Map<string, { source: SessionSummary; value: GroupSession }>();
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
        const previousTree = this.projects();
        const nextProjects = new Map<string, Project>();
        const nextWorkspaces = new Map<string, ProjectWorkspace>();
        const nextSessions = new Map<string, SessionSummary>();
        const changedProjectIds = new Set<string>();

        for (const project of hello.projects) {
            const known = this.#projects.get(project.id);
            if (known !== undefined && known.version >= project.version) {
                nextProjects.set(project.id, known);
            } else {
                nextProjects.set(project.id, project);
                changedProjectIds.add(project.id);
            }
        }
        for (const project of this.#projects.values()) {
            if (nextProjects.has(project.id)) continue;
            changedProjectIds.add(project.id);
            this.#groups.delete(project.id);
        }

        for (const workspace of hello.workspaces) {
            const known = this.#workspaces.get(workspace.id);
            if (known !== undefined && known.version >= workspace.version) {
                nextWorkspaces.set(workspace.id, known);
            } else {
                nextWorkspaces.set(workspace.id, workspace);
                changedProjectIds.add(workspace.projectId);
                if (known !== undefined) changedProjectIds.add(known.projectId);
            }
        }
        for (const workspace of this.#workspaces.values()) {
            if (nextWorkspaces.has(workspace.id)) continue;
            changedProjectIds.add(workspace.projectId);
            this.#workspaceGroups.delete(workspace.id);
            this.#workspaceGroupSources.delete(workspace.id);
        }

        for (const session of hello.sessions) {
            const known = this.#sessions.get(session.id);
            if (known !== undefined && sameSessionSummary(known, session)) {
                nextSessions.set(session.id, known);
            } else {
                nextSessions.set(session.id, session);
                changedProjectIds.add(session.projectId);
                if (known !== undefined) changedProjectIds.add(known.projectId);
            }
        }
        for (const session of this.#sessions.values()) {
            if (nextSessions.has(session.id)) continue;
            changedProjectIds.add(session.projectId);
            this.#sessionEventIds.delete(session.id);
            this.#groupSessions.delete(session.id);
        }

        this.#projects = nextProjects;
        this.#workspaces = nextWorkspaces;
        this.#sessions = nextSessions;
        for (const projectId of changedProjectIds) this.#markDirty(projectId);
        // Git snapshots survive: they are live-only, so the stream replays them
        // after this frame and dropping them here would blank a branch a client
        // is already showing.

        const deltas: GroupDelta[] = [];
        if (this.#state.sessionsComplete !== hello.sessionsComplete) {
            this.#state = { ...this.#state, sessionsComplete: hello.sessionsComplete };
            deltas.push({ state: this.#state, type: "groups_state_changed" });
        }
        const projects = this.projects();
        if (projects !== previousTree) deltas.push({ projects, type: "projects_changed" });
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
                if (known !== undefined && known.version >= project.version) return [];
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
                if (known !== undefined && known.version >= workspace.version) return [];
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
        into.set(key, applicationGit(git));
        return true;
    }

    #markDirty(projectId: string): void {
        this.#dirty.add(projectId);
        this.#groups.delete(projectId);
        this.#treeStale = true;
    }

    #rebuild(): void {
        this.#treeStale = false;
        const sessionsByProject = new Map<string, GroupSession[]>();
        const sessionsByWorkspace = new Map<string, GroupSession[]>();
        for (const session of this.#sessions.values()) {
            if (session.archived) continue;
            const projected = this.#groupSession(session);
            const into =
                session.workspaceId === undefined
                    ? mapList(sessionsByProject, session.projectId)
                    : mapList(sessionsByWorkspace, session.workspaceId);
            into.push(projected);
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
            if (cached !== undefined) {
                next.push(cached);
                continue;
            }
            const workspaces = (workspacesByProject.get(project.id) ?? [])
                .sort(byOrderKey)
                .map((workspace) => this.#workspaceGroup(workspace, sessionsByWorkspace));
            const group: ProjectGroup = {
                ...(project.avatar === undefined
                    ? {}
                    : {
                          avatar: {
                              height: project.avatar.height,
                              url: project.avatar.url,
                              width: project.avatar.width,
                          },
                      }),
                id: project.id,
                kind: project.kind,
                name: project.name,
                orderKey: project.orderKey,
                path: project.path,
                presence: project.presence,
                sessions: (sessionsByProject.get(project.id) ?? []).sort(byOrderKey),
                usage: usageOf([
                    ...(sessionsByProject.get(project.id) ?? []),
                    ...workspaces.flatMap((workspace) => workspace.sessions),
                ]),
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
        sessionsByWorkspace: Map<string, GroupSession[]>,
    ): WorkspaceGroup {
        const cached = this.#workspaceGroups.get(workspace.id);
        const sessions = (sessionsByWorkspace.get(workspace.id) ?? []).sort(byOrderKey);
        if (
            cached !== undefined &&
            this.#workspaceGroupSources.get(workspace.id) === workspace &&
            sameSessions(cached.sessions, sessions)
        ) {
            return cached;
        }
        const group: WorkspaceGroup = {
            id: workspace.id,
            name: workspace.name,
            orderKey: workspace.orderKey,
            path: workspace.path,
            presence: workspace.presence,
            projectId: workspace.projectId,
            sessions,
            status: workspace.status as WorkspaceGroup["status"],
            ...(workspace.title === undefined ? {} : { title: workspace.title }),
            usage: usageOf(sessions),
            ...(this.#workspaceGit.has(workspace.id)
                ? { git: this.#workspaceGit.get(workspace.id) as GitChangeSnapshot }
                : {}),
        };
        this.#workspaceGroups.set(workspace.id, group);
        this.#workspaceGroupSources.set(workspace.id, workspace);
        return group;
    }

    #groupSession(session: SessionSummary): GroupSession {
        const cached = this.#groupSessions.get(session.id);
        if (cached?.source === session) return cached.value;
        const value: GroupSession = {
            archived: session.archived,
            createdAt: session.createdAt,
            cwd: session.cwd,
            id: session.id,
            modelId: session.modelId,
            orderKey: session.orderKey,
            permissionMode: session.permissionMode,
            projectId: session.projectId,
            providerId: session.providerId,
            status: session.status,
            updatedAt: session.updatedAt,
            ...(session.workspaceId === undefined ? {} : { workspaceId: session.workspaceId }),
            ...(session.draft === undefined ? {} : { draft: session.draft }),
            ...(session.draftUpdatedAt === undefined
                ? {}
                : { draftUpdatedAt: session.draftUpdatedAt }),
            ...(session.effort === undefined ? {} : { effort: session.effort }),
            ...(session.lastMessageAt === undefined
                ? {}
                : { lastMessageAt: session.lastMessageAt }),
            ...(session.recap === undefined ? {} : { recap: session.recap }),
            ...(session.serviceTier === undefined ? {} : { serviceTier: session.serviceTier }),
            ...(session.sessionTokenCount === undefined
                ? {}
                : { sessionTokenCount: session.sessionTokenCount }),
            ...(session.title === undefined ? {} : { title: session.title }),
        };
        this.#groupSessions.set(session.id, { source: session, value });
        return value;
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
function sameSessions(left: readonly GroupSession[], right: readonly GroupSession[]): boolean {
    if (left.length !== right.length) return false;
    return left.every((item, index) => item === right[index]);
}

function usageOf(sessions: readonly GroupSession[]): { totalTokens: number } {
    return {
        totalTokens: sessions.reduce(
            (total, session) => total + (session.sessionTokenCount?.totalTokens ?? 0),
            0,
        ),
    };
}

function sameSessionSummary(left: SessionSummary, right: SessionSummary): boolean {
    if (left === right) return true;
    const leftRecord = left as unknown as Record<string, unknown>;
    const rightRecord = right as unknown as Record<string, unknown>;
    const leftKeys = Object.keys(leftRecord);
    const rightKeys = Object.keys(rightRecord);
    return (
        leftKeys.length === rightKeys.length &&
        leftKeys.every(
            (key) =>
                Object.hasOwn(rightRecord, key) &&
                sameProtocolValue(leftRecord[key], rightRecord[key]),
        )
    );
}

/** Equality for the bounded JSON values carried by one protocol entity. */
function sameProtocolValue(left: unknown, right: unknown): boolean {
    if (Object.is(left, right)) return true;
    if (left === null || right === null || typeof left !== "object" || typeof right !== "object") {
        return false;
    }
    if (Array.isArray(left) || Array.isArray(right)) {
        return (
            Array.isArray(left) &&
            Array.isArray(right) &&
            left.length === right.length &&
            left.every((item, index) => sameProtocolValue(item, right[index]))
        );
    }
    const leftRecord = left as Record<string, unknown>;
    const rightRecord = right as Record<string, unknown>;
    const leftKeys = Object.keys(leftRecord);
    const rightKeys = Object.keys(rightRecord);
    return (
        leftKeys.length === rightKeys.length &&
        leftKeys.every(
            (key) =>
                Object.hasOwn(rightRecord, key) &&
                sameProtocolValue(leftRecord[key], rightRecord[key]),
        )
    );
}

function isArchivedWorkspace(workspace: ProjectWorkspace): boolean {
    return workspace.archivedAt !== undefined || workspace.status === "archived";
}

function applicationGit(git: GitChangeSnapshot): GitChangeSnapshot {
    return {
        ...git,
        revision: `${git.generation}:${String(git.version)}:${String(git.scannedAt)}`,
    };
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
            const { recap, status, title } = event.data as {
                recap?: string;
                status: string;
                title?: string;
            };
            // Generating and error events omit the title and recap even though
            // the daemon retains them. Once metadata is idle or ready, omission
            // is authoritative and clears the corresponding value.
            const settled = status === "idle" || status === "ready";
            const set: Partial<SessionSummary> = { titleStatus: status };
            const clear: (keyof SessionSummary)[] = [];
            if (title !== undefined) set.title = title;
            else if (settled) clear.push("title");
            if (recap !== undefined) set.recap = recap;
            else if (settled) clear.push("recap");
            return { clear, set };
        }
        case "session_configuration_changed": {
            const { effort, modelId, serviceTier } = event.data as {
                effort?: string;
                modelId: string;
                serviceTier: string | null;
            };
            return {
                clear: [
                    ...(effort === undefined ? (["effort"] as const) : []),
                    ...(serviceTier === null ? (["serviceTier"] as const) : []),
                ],
                set: {
                    modelId,
                    ...(effort === undefined ? {} : { effort }),
                    ...(serviceTier === null ? {} : { serviceTier }),
                },
            };
        }
        case "session_draft_changed": {
            const { draft, updatedAt } = event.data as { draft?: string; updatedAt: number };
            return {
                ...(draft === undefined ? { clear: ["draft"] } : {}),
                set: {
                    draftUpdatedAt: updatedAt,
                    ...(draft === undefined ? {} : { draft }),
                },
            };
        }
        case "session_context_changed":
            return {
                set: {
                    sessionTokenCount: (event.data as { sessionTokenCount: SessionTokenCount })
                        .sessionTokenCount,
                },
            };
        case "permission_mode_changed": {
            const { permissionMode } = event.data as { permissionMode: string };
            return { set: { permissionMode } };
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
