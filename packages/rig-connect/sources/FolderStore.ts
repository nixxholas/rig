import type {
    FolderDelta,
    FolderNode,
    FolderSession,
    FolderView,
    FoldersState,
} from "./FolderElement.js";
import type {
    Folder,
    GlobalEvent,
    GlobalStreamHello,
    SessionScope,
    SessionEvent,
    SessionSummary,
} from "./protocol.js";
import { sessionUnreadAfterEvent } from "./sessionUnread.js";

const ROOT = "";
const EMPTY_SESSIONS: readonly FolderSession[] = [];

/** Projects the flat folder/session catalog into the one tree a folder view renders. */
export class FolderStore {
    #folders = new Map<string, Folder>();
    #sessions = new Map<string, SessionSummary>();
    #sessionValues = new Map<string, { source: SessionSummary; value: FolderSession }>();
    #nodes = new Map<
        string,
        {
            children: readonly FolderNode[];
            sessions: readonly FolderSession[];
            source: Folder;
            value: FolderNode;
        }
    >();
    #view: FolderView = { folders: [], unsorted: [] };
    #viewStale = true;
    #state: FoldersState = { connection: "connecting" };

    view(): FolderView {
        if (this.#viewStale) this.#rebuild();
        return this.#view;
    }

    folders(): readonly FolderNode[] {
        return this.view().folders;
    }

    unsorted(): readonly FolderSession[] {
        return this.view().unsorted;
    }

    folder(folderId: string): Folder | undefined {
        return this.#folders.get(folderId);
    }

    sessionSummary(sessionId: string): SessionSummary | undefined {
        return this.#sessions.get(sessionId);
    }

    state(): FoldersState {
        return this.#state;
    }

    setConnection(connection: FoldersState["connection"]): FolderDelta[] {
        if (this.#state.connection === connection) return [];
        this.#state = { connection };
        return [{ state: this.#state, type: "folders_state_changed" }];
    }

    applyHello(hello: GlobalStreamHello): FolderDelta[] {
        const folderDeltas = this.replaceFolders(hello.folders);
        const sessionDeltas = this.applyCatalogSessions(hello.sessions);
        const changed = [...folderDeltas, ...sessionDeltas].some(
            (delta) => delta.type === "folders_changed",
        );
        return [
            ...(changed ? ([{ type: "folders_changed", view: this.view() }] as const) : []),
            ...folderDeltas.filter((delta) => delta.type !== "folders_changed"),
            ...sessionDeltas.filter((delta) => delta.type !== "folders_changed"),
        ];
    }

    applyCatalogSessions(sessions: readonly SessionSummary[]): FolderDelta[] {
        const previous = this.view();
        const nextSessions = new Map<string, SessionSummary>();
        for (const session of sessions) {
            if (session.orderKey === undefined) continue;
            const known = this.#sessions.get(session.id);
            nextSessions.set(
                session.id,
                known !== undefined && sameValue(known, session) ? known : session,
            );
        }
        for (const id of this.#sessions.keys()) {
            if (!nextSessions.has(id)) this.#sessionValues.delete(id);
        }
        this.#sessions = nextSessions;
        this.#viewStale = true;
        const view = this.view();
        return view === previous ? [] : [{ type: "folders_changed", view }];
    }

    replaceFolders(folders: readonly Folder[]): FolderDelta[] {
        const previous = this.view();
        const old = this.#folders;
        const next = new Map<string, Folder>();
        const deltas: FolderDelta[] = [];
        for (const folder of folders) {
            const known = old.get(folder.id);
            const current = known !== undefined && known.version >= folder.version ? known : folder;
            next.set(folder.id, current);
            if (isVisible(current) && !isVisible(known)) {
                deltas.push({ folderId: folder.id, type: "folder_added" });
            }
            if (known !== current) this.#nodes.delete(folder.id);
        }
        for (const folder of old.values()) {
            if (next.has(folder.id)) continue;
            this.#nodes.delete(folder.id);
            if (isVisible(folder)) deltas.push({ folderId: folder.id, type: "folder_removed" });
        }
        this.#folders = next;
        this.#viewStale = true;
        const view = this.view();
        if (view !== previous) deltas.unshift({ type: "folders_changed", view });
        return deltas;
    }

    applyFolder(folder: Folder): FolderDelta[] {
        const known = this.#folders.get(folder.id);
        if (known !== undefined && known.version >= folder.version) return [];
        const previous = this.view();
        this.#folders.set(folder.id, folder);
        this.#nodes.delete(folder.id);
        this.#viewStale = true;
        const deltas: FolderDelta[] = [];
        if (isVisible(folder) && !isVisible(known)) {
            deltas.push({ folderId: folder.id, type: "folder_added" });
        }
        if (!isVisible(folder) && isVisible(known)) {
            deltas.push({ folderId: folder.id, type: "folder_removed" });
        }
        const view = this.view();
        if (view !== previous) deltas.unshift({ type: "folders_changed", view });
        return deltas;
    }

    apply(event: GlobalEvent): FolderDelta[] {
        const sessionId = "sessionId" in event ? event.sessionId : undefined;
        if (typeof sessionId !== "string") return [];
        const known = this.#sessions.get(sessionId);
        let updated: SessionSummary | undefined;
        if (event.type === "session_current") {
            updated = (event.data as { session: SessionSummary }).session;
        } else if (event.type === "session_created" || event.type === "session_updated") {
            const incoming = (event.data as { session?: Partial<SessionSummary> }).session;
            if (incoming?.id !== sessionId) return [];
            updated = { ...known, ...incoming } as SessionSummary;
        } else if (event.type === "session_archived" && known !== undefined) {
            updated = { ...known, archived: (event.data as { archived: boolean }).archived };
        } else if (event.type === "session_status_changed" && known !== undefined) {
            updated = {
                ...known,
                status: (event.data as { status: SessionSummary["status"] }).status,
            };
        } else if (event.type === "session_title_changed" && known !== undefined) {
            const data = event.data as {
                recap?: string;
                status: SessionSummary["titleStatus"];
                title?: string;
            };
            updated = { ...known, titleStatus: data.status };
            if (data.title === undefined) delete updated.title;
            else updated.title = data.title;
            if (data.recap === undefined) delete updated.recap;
            else updated.recap = data.recap;
        } else if (event.type === "session_draft_changed" && known !== undefined) {
            const data = event.data as { draft?: string; updatedAt: number };
            updated = { ...known, draftUpdatedAt: data.updatedAt };
            if (data.draft === undefined) delete updated.draft;
            else updated.draft = data.draft;
        } else if (event.type === "session_configuration_changed" && known !== undefined) {
            const data = event.data as {
                effort?: string;
                modelId: string;
                serviceTier: string | null;
            };
            updated = { ...known, modelId: data.modelId };
            if (data.effort === undefined) delete updated.effort;
            else updated.effort = data.effort;
            if (data.serviceTier === null) delete updated.serviceTier;
            else updated.serviceTier = data.serviceTier;
        } else if (event.type === "permission_mode_changed" && known !== undefined) {
            updated = {
                ...known,
                permissionMode: (event.data as { permissionMode: string }).permissionMode,
            };
        } else if (event.type === "session_context_changed" && known !== undefined) {
            updated = { ...known };
            const tokenCount = (
                event.data as { sessionTokenCount: SessionSummary["sessionTokenCount"] }
            ).sessionTokenCount;
            if (tokenCount === undefined) delete updated.sessionTokenCount;
            else updated.sessionTokenCount = tokenCount;
        } else if (event.type === "session_activity_changed" && known !== undefined) {
            const wait = (
                event.data as {
                    activity: {
                        wait?: NonNullable<SessionSummary["wait"]> & { toolCallId?: string };
                    };
                }
            ).activity.wait;
            updated = { ...known };
            if (wait === undefined) delete updated.wait;
            else updated.wait = wait;
        } else if (known?.trackUnread === true) {
            const unread = sessionUnreadAfterEvent(known.unread, event as SessionEvent);
            if (unread !== undefined && unread !== known.unread) updated = { ...known, unread };
        }
        if (updated === undefined || updated.orderKey === undefined) return [];
        return this.#setSession({ ...updated, lastEventId: event.id });
    }

    applyOptimisticFolder(folder: Folder): { deltas: readonly FolderDelta[]; undo: () => void } {
        const known = this.#folders.get(folder.id);
        const deltas = this.applyFolder(folder);
        return {
            deltas,
            undo: () => {
                if (known === undefined) this.#folders.delete(folder.id);
                else this.#folders.set(folder.id, known);
                this.#nodes.delete(folder.id);
                this.#viewStale = true;
            },
        };
    }

    applyOptimisticFolderPatch(
        folderId: string,
        patch: Partial<Folder>,
        clear: readonly ("description" | "icon" | "rules")[] = [],
    ): { deltas: readonly FolderDelta[]; undo: () => void } {
        const known = this.#folders.get(folderId);
        if (known === undefined) return { deltas: [], undo: () => undefined };
        const previous = this.view();
        const updated = { ...known, ...patch };
        for (const key of clear) delete updated[key];
        this.#folders.set(folderId, updated);
        this.#nodes.delete(folderId);
        this.#viewStale = true;
        const view = this.view();
        return {
            deltas: view === previous ? [] : [{ type: "folders_changed", view }],
            undo: () => {
                this.#folders.set(folderId, known);
                this.#nodes.delete(folderId);
                this.#viewStale = true;
            },
        };
    }

    applyOptimisticMove(
        folderId: string,
        parentId: string | null,
        afterId: string | null,
    ): { deltas: readonly FolderDelta[]; undo: () => void } {
        const known = this.#folders.get(folderId);
        if (known === undefined) return { deltas: [], undo: () => undefined };
        const siblings = [...this.#folders.values()]
            .filter(
                (folder) =>
                    folder.id !== folderId &&
                    folder.archivedAt === undefined &&
                    folder.parentId === (parentId ?? undefined),
            )
            .sort(byOrderKey);
        const afterIndex =
            afterId === null ? -1 : siblings.findIndex((folder) => folder.id === afterId);
        const after = afterIndex < 0 ? undefined : siblings[afterIndex];
        const before = siblings[afterIndex + 1];
        const orderKey =
            after === undefined
                ? `\u0000${before?.orderKey ?? ""}`
                : before === undefined
                  ? `${after.orderKey}\uffff`
                  : `${after.orderKey}\u0000`;
        if (parentId !== null) {
            return this.applyOptimisticFolderPatch(folderId, { orderKey, parentId });
        }
        const previous = this.view();
        const { parentId: _, ...atRoot } = known;
        this.#folders.set(folderId, { ...atRoot, orderKey });
        this.#nodes.delete(folderId);
        this.#viewStale = true;
        const view = this.view();
        return {
            deltas: view === previous ? [] : [{ type: "folders_changed", view }],
            undo: () => {
                this.#folders.set(folderId, known);
                this.#nodes.delete(folderId);
                this.#viewStale = true;
            },
        };
    }

    applyOptimisticArchive(
        folderId: string,
        archivedAt: number,
    ): {
        deltas: readonly FolderDelta[];
        folderIds: readonly string[];
        sessionIds: readonly string[];
        undo: () => void;
    } {
        const descendants = new Set([folderId]);
        let changed = true;
        while (changed) {
            changed = false;
            for (const folder of this.#folders.values()) {
                if (
                    folder.parentId !== undefined &&
                    descendants.has(folder.parentId) &&
                    !descendants.has(folder.id)
                ) {
                    descendants.add(folder.id);
                    changed = true;
                }
            }
        }
        const previous = new Map<string, Folder>();
        const previousSessions = new Map<string, SessionSummary>();
        const before = this.view();
        for (const id of descendants) {
            const folder = this.#folders.get(id);
            if (folder === undefined) continue;
            previous.set(id, folder);
            this.#folders.set(id, { ...folder, archivedAt });
            this.#nodes.delete(id);
        }
        for (const session of this.#sessions.values()) {
            if (
                session.scope.kind !== "folder" ||
                !descendants.has(session.scope.folderId) ||
                session.archived
            ) {
                continue;
            }
            previousSessions.set(session.id, session);
            this.#sessions.set(session.id, { ...session, archived: true });
            this.#sessionValues.delete(session.id);
        }
        this.#viewStale = true;
        const view = this.view();
        return {
            deltas: view === before ? [] : [{ type: "folders_changed", view }],
            folderIds: [...descendants],
            sessionIds: [...previousSessions.keys()],
            undo: () => {
                for (const [id, folder] of previous) this.#folders.set(id, folder);
                for (const [id, session] of previousSessions) {
                    this.#sessions.set(id, session);
                    this.#sessionValues.delete(id);
                }
                this.#viewStale = true;
            },
        };
    }

    applyOptimisticSessionScope(
        sessionId: string,
        scope: Extract<SessionScope, { kind: "folder" | "unsorted" }>,
        orderKey: string,
    ): { deltas: readonly FolderDelta[]; undo: () => void } {
        const known = this.#sessions.get(sessionId);
        if (known === undefined) return { deltas: [], undo: () => undefined };
        const deltas = this.#setSession({ ...known, orderKey, scope });
        return {
            deltas,
            undo: () => {
                this.#sessions.set(sessionId, known);
                this.#sessionValues.delete(sessionId);
                this.#viewStale = true;
            },
        };
    }

    applyOptimisticSessionCreate(session: SessionSummary): {
        deltas: readonly FolderDelta[];
        undo: () => void;
    } {
        if (this.#sessions.has(session.id)) return { deltas: [], undo: () => undefined };
        const deltas = this.#setSession(session);
        return {
            deltas,
            undo: () => {
                this.#sessions.delete(session.id);
                this.#sessionValues.delete(session.id);
                this.#viewStale = true;
            },
        };
    }

    optimisticSessionOrderKey(
        scope: Extract<SessionScope, { kind: "folder" | "unsorted" }>,
        afterId?: string | null,
    ): string {
        const siblings = [...this.#sessions.values()]
            .filter((session) => sameScope(session.scope, scope) && !session.archived)
            .sort(byOrderKey);
        const afterIndex =
            afterId === undefined
                ? siblings.length - 1
                : afterId === null
                  ? -1
                  : siblings.findIndex((item) => item.id === afterId);
        const after = afterIndex < 0 ? undefined : siblings[afterIndex];
        const before = siblings[afterIndex + 1];
        return after === undefined
            ? `\u0000${before?.orderKey ?? ""}`
            : before === undefined
              ? `${after.orderKey ?? ""}\uffff`
              : `${after.orderKey ?? ""}\u0000`;
    }

    #setSession(session: SessionSummary): FolderDelta[] {
        const known = this.#sessions.get(session.id);
        if (known !== undefined && sameValue(known, session)) return [];
        const wasVisible = isFolderSession(known);
        const previous = this.view();
        this.#sessions.set(session.id, session);
        this.#sessionValues.delete(session.id);
        this.#viewStale = true;
        const visible = isFolderSession(session);
        const view = this.view();
        return [
            ...(view === previous ? [] : ([{ type: "folders_changed", view }] as const)),
            ...(!wasVisible && visible
                ? ([{ sessionId: session.id, type: "session_added" }] as const)
                : wasVisible && !visible
                  ? ([{ sessionId: session.id, type: "session_removed" }] as const)
                  : []),
        ];
    }

    #rebuild(): void {
        this.#viewStale = false;
        const sessionsByFolder = new Map<string, FolderSession[]>();
        const unsorted: FolderSession[] = [];
        for (const session of this.#sessions.values()) {
            if (!isFolderSession(session)) continue;
            const projected = this.#session(session);
            if (session.scope.kind === "unsorted") unsorted.push(projected);
            else if (session.scope.kind === "folder") {
                mapList(sessionsByFolder, session.scope.folderId).push(projected);
            }
        }
        for (const sessions of sessionsByFolder.values()) sessions.sort(byOrderKey);
        unsorted.sort(byOrderKey);

        const visible = [...this.#folders.values()].filter(isVisible);
        const known = new Set(visible.map((folder) => folder.id));
        const childrenOf = new Map<string, Folder[]>();
        for (const folder of visible) {
            const parentId =
                folder.parentId !== undefined && known.has(folder.parentId)
                    ? folder.parentId
                    : ROOT;
            mapList(childrenOf, parentId).push(folder);
        }
        for (const siblings of childrenOf.values()) siblings.sort(byOrderKey);
        const folders = this.#nodesUnder(ROOT, childrenOf, sessionsByFolder, new Set());
        const previous = this.#view;
        const nextUnsorted = sameItems(previous.unsorted, unsorted) ? previous.unsorted : unsorted;
        this.#view =
            previous.folders === folders && previous.unsorted === nextUnsorted
                ? previous
                : { folders, unsorted: nextUnsorted };
    }

    #nodesUnder(
        parentId: string,
        childrenOf: Map<string, Folder[]>,
        sessionsByFolder: Map<string, FolderSession[]>,
        open: Set<string>,
    ): readonly FolderNode[] {
        if (open.has(parentId)) return [];
        open.add(parentId);
        const nodes = (childrenOf.get(parentId) ?? []).map((folder) =>
            this.#node(folder, childrenOf, sessionsByFolder, open),
        );
        open.delete(parentId);
        const previous =
            parentId === ROOT ? this.#view.folders : this.#nodes.get(parentId)?.children;
        return previous !== undefined && sameItems(previous, nodes) ? previous : nodes;
    }

    #node(
        folder: Folder,
        childrenOf: Map<string, Folder[]>,
        sessionsByFolder: Map<string, FolderSession[]>,
        open: Set<string>,
    ): FolderNode {
        const children = this.#nodesUnder(folder.id, childrenOf, sessionsByFolder, open);
        const sessions = sessionsByFolder.get(folder.id) ?? EMPTY_SESSIONS;
        const cached = this.#nodes.get(folder.id);
        if (
            cached?.source === folder &&
            cached.children === children &&
            sameItems(cached.sessions, sessions)
        ) {
            return cached.value;
        }
        const value: FolderNode = {
            children,
            createdAt: folder.createdAt,
            id: folder.id,
            name: folder.name,
            orderKey: folder.orderKey,
            path: folder.path,
            sessions,
            updatedAt: folder.updatedAt,
            ...(folder.archivedAt === undefined ? {} : { archivedAt: folder.archivedAt }),
            ...(folder.description === undefined ? {} : { description: folder.description }),
            ...(folder.icon === undefined ? {} : { icon: folder.icon }),
            ...(folder.parentId === undefined ? {} : { parentId: folder.parentId }),
            ...(folder.rules === undefined ? {} : { rules: folder.rules }),
        };
        this.#nodes.set(folder.id, { children, sessions, source: folder, value });
        return value;
    }

    #session(session: SessionSummary): FolderSession {
        const cached = this.#sessionValues.get(session.id);
        if (cached?.source === session) return cached.value;
        const value: FolderSession = {
            archived: session.archived,
            createdAt: session.createdAt,
            cwd: session.cwd,
            id: session.id,
            modelId: session.modelId,
            orderKey: session.orderKey ?? "",
            permissionMode: session.permissionMode,
            providerId: session.providerId,
            scope: session.scope as Extract<SessionScope, { kind: "folder" | "unsorted" }>,
            status: session.status,
            trackUnread: session.trackUnread === true,
            updatedAt: session.updatedAt,
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
            ...(session.unread === undefined ? {} : { unread: session.unread }),
            ...(session.wait === undefined
                ? {}
                : { wait: { dueAt: session.wait.dueAt, startedAt: session.wait.startedAt } }),
        };
        this.#sessionValues.set(session.id, { source: session, value });
        return value;
    }
}

function isVisible(folder: Folder | undefined): boolean {
    return folder !== undefined && folder.archivedAt === undefined;
}

function isFolderSession(session: SessionSummary | undefined): boolean {
    return (
        session !== undefined &&
        !session.archived &&
        session.orderKey !== undefined &&
        (session.scope.kind === "folder" || session.scope.kind === "unsorted")
    );
}

function sameScope(left: SessionScope, right: SessionScope): boolean {
    return (
        left.kind === right.kind &&
        (left.kind !== "folder" || (right.kind === "folder" && left.folderId === right.folderId))
    );
}

function mapList<T>(map: Map<string, T[]>, key: string): T[] {
    const known = map.get(key);
    if (known !== undefined) return known;
    const created: T[] = [];
    map.set(key, created);
    return created;
}

function byOrderKey(
    left: { id: string; orderKey?: string },
    right: { id: string; orderKey?: string },
): number {
    const leftKey = left.orderKey ?? "";
    const rightKey = right.orderKey ?? "";
    if (leftKey !== rightKey) return leftKey < rightKey ? -1 : 1;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function sameItems<T>(left: readonly T[], right: readonly T[]): boolean {
    return left.length === right.length && left.every((item, index) => item === right[index]);
}

function sameValue(left: unknown, right: unknown): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
}
