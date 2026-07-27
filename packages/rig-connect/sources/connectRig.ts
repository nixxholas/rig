import type {
    ChatDelta,
    ChatElement,
    MutationAction,
    MutationRejectedDelta,
    SessionState,
} from "./ChatElement.js";
import { ChatStore } from "./ChatStore.js";
import type { GroupDelta, GroupsState, ProjectGroup } from "./GroupElement.js";
import { GroupStore } from "./GroupStore.js";
import { orderedUuidV7, type RandomValues } from "./orderedUuidV7.js";
import type {
    ContentBlock,
    GlobalEvent,
    MutationId,
    Project,
    ProjectWorkspace,
    ProtocolSession,
    RemoteTerminalGroupState,
    SessionEvent,
    SessionTranscriptWindow,
} from "./protocol.js";
import { streamGlobalEvents } from "./streamGlobalEvents.js";
import { streamSessionEvents } from "./streamSessionEvents.js";

const INITIAL_MUTATION_RETRY_MS = 100;
const MAXIMUM_MUTATION_RETRY_MS = 5_000;
const MAXIMUM_PENDING_PER_ENTITY = 256;

export interface ConnectRigOptions {
    endpoint: string;
    token: string;
    /** Test seam. Defaults to the global `fetch`. */
    fetch?: typeof globalThis.fetch;
    /** Test seam shared by stream reconnects and mutation backoff. */
    wait?: (ms: number, signal: AbortSignal) => Promise<void>;
    /** Test seam for UUIDv7 timestamps and optimistic occurrence times. */
    now?: () => number;
    /** Test seam. Production uses Web Crypto. */
    randomValues?: RandomValues;
    mutationRetryDelayMs?: number;
}

export interface RigSessionSubscriptionOptions {
    sessionId: string;
    onChange: (elements: readonly ChatElement[], session: SessionState) => void;
    onDelta?: (delta: ChatDelta) => void;
    onError?: (error: unknown) => void;
    transcriptTurnLimit?: number;
}

export interface RigGroupsSubscriptionOptions {
    onChange: (projects: readonly ProjectGroup[], state: GroupsState) => void;
    onDelta?: (delta: GroupDelta) => void;
    onError?: (error: unknown) => void;
}

export interface RigSessionConnection {
    elements: () => readonly ChatElement[];
    session: () => SessionState;
    loadMore: (token: string) => void;
    close: () => void;
}

export interface RigGroupsConnection {
    projects: () => readonly ProjectGroup[];
    remoteTerminals: () => readonly RemoteTerminalGroupState[];
    state: () => GroupsState;
    close: () => void;
}

export interface SendMessageInput {
    content?: readonly ContentBlock[];
    displayText?: string;
    text: string;
}

export interface ModelSelection {
    modelId: string;
    providerId?: string;
}

export type GroupTarget =
    | { kind: "project"; projectId: string }
    | { kind: "workspace"; projectId: string; workspaceId: string };

/**
 * One shared Rig connection.
 *
 * Every action returns a mutation identity synchronously, after its prediction
 * is already visible. Delivery, retries, reconciliation, and rejection are
 * handled in the background.
 */
export interface RigConnection {
    connectSession: (options: RigSessionSubscriptionOptions) => RigSessionConnection;
    connectGroups: (options: RigGroupsSubscriptionOptions) => RigGroupsConnection;
    sendMessage: (sessionId: string, message: string | SendMessageInput) => MutationId;
    stopRun: (sessionId: string) => MutationId;
    switchModel: (sessionId: string, selection: string | ModelSelection) => MutationId;
    setSessionArchived: (sessionId: string, archived: boolean) => MutationId;
    renameGroup: (target: GroupTarget, name: string) => MutationId;
    close: () => void;
}

interface SessionSubscriber extends RigSessionSubscriptionOptions {
    closed: boolean;
}

interface GroupSubscriber extends RigGroupsSubscriptionOptions {
    closed: boolean;
}

interface SessionEntry {
    controller: AbortController;
    detachRoot: () => void;
    started: boolean;
    store: ChatStore;
    subscribers: Set<SessionSubscriber>;
    transcriptTurnLimit?: number;
}

interface GroupEntry {
    controller: AbortController;
    detachRoot: () => void;
    started: boolean;
    store: GroupStore;
    subscribers: Set<GroupSubscriber>;
}

interface MutationRequest {
    body?: unknown;
    headers?: Readonly<Record<string, string>>;
    method: "PATCH" | "POST";
    url: string;
}

interface PendingMutation {
    acknowledged: boolean;
    action: MutationAction;
    applyOptimistic: (publish: boolean) => () => void;
    attemptController?: AbortController;
    entityKey: string;
    id: MutationId;
    matchesAuthoritative?: (data: unknown) => boolean;
    prepare: () => MutationRequest;
    sessionId?: string;
    undo: () => void;
}

interface ReconcileOutput {
    groupDeltas?: readonly GroupDelta[];
    sessionDeltas?: ReadonlyMap<string, readonly ChatDelta[]>;
}

interface SessionCapture {
    elements: readonly ChatElement[];
    entry: SessionEntry;
    session: SessionState;
}

interface GroupCapture {
    entry: GroupEntry;
    projects: readonly ProjectGroup[];
    state: GroupsState;
}

/** Creates the one client a UI shares across its group and session views. */
export function connectRig(options: ConnectRigOptions): RigConnection {
    const request = options.fetch ?? globalThis.fetch;
    const wait = options.wait ?? defaultWait;
    const now = options.now ?? Date.now;
    const nextMutationId = orderedUuidV7(now, options.randomValues);
    const rootController = new AbortController();
    const sessionEntries = new Map<string, SessionEntry>();
    const queues = new Map<string, PendingMutation[]>();
    const activeWorkers = new Set<string>();
    const pendingOverlays: PendingMutation[] = [];
    const knownSessionCursors = new Map<string, string>();
    const knownGroupVersions = new Map<string, number>();
    let groupsEntry: GroupEntry | undefined;
    let closed = false;

    const publishSession = (entry: SessionEntry, deltas: readonly ChatDelta[]): void => {
        if (closed || deltas.length === 0) return;
        for (const subscriber of [...entry.subscribers]) {
            if (subscriber.closed) continue;
            subscriber.onChange(entry.store.elements(), entry.store.session());
            for (const delta of deltas) subscriber.onDelta?.(delta);
        }
    };

    const publishGroups = (entry: GroupEntry, deltas: readonly GroupDelta[]): void => {
        if (closed || deltas.length === 0) return;
        for (const subscriber of [...entry.subscribers]) {
            if (subscriber.closed) continue;
            subscriber.onChange(entry.store.projects(), entry.store.state());
            for (const delta of deltas) subscriber.onDelta?.(delta);
        }
    };

    const applyOutput = (output: ReconcileOutput): void => {
        for (const [sessionId, deltas] of output.sessionDeltas ?? []) {
            const entry = sessionEntries.get(sessionId);
            if (entry !== undefined) publishSession(entry, deltas);
        }
        if (output.groupDeltas !== undefined && groupsEntry !== undefined) {
            publishGroups(groupsEntry, output.groupDeltas);
        }
    };

    const acknowledge = (mutationId: string | undefined): void => {
        if (mutationId === undefined) return;
        const mutation = pendingOverlays.find((candidate) => candidate.id === mutationId);
        if (mutation === undefined) return;
        mutation.acknowledged = true;
        mutation.attemptController?.abort();
        const index = pendingOverlays.indexOf(mutation);
        if (index >= 0) pendingOverlays.splice(index, 1);
    };

    /**
     * Applies one authoritative update beneath the optimistic layer.
     *
     * Predictions are removed in reverse order and reapplied in FIFO order,
     * which makes every undo capture the newest authoritative-before value.
     */
    const reconcile = (
        entityKeys: readonly string[],
        mutationId: string | undefined,
        affectedSessionIds: readonly string[],
        affectsGroups: boolean,
        authoritative: () => ReconcileOutput,
    ): void => {
        const keys = new Set(entityKeys);
        const relevant = pendingOverlays.filter((mutation) => keys.has(mutation.entityKey));
        if (relevant.length === 0) {
            acknowledge(mutationId);
            applyOutput(authoritative());
            return;
        }

        const sessionIds = new Set(affectedSessionIds);
        for (const mutation of relevant) {
            if (mutation.sessionId !== undefined) sessionIds.add(mutation.sessionId);
        }
        const sessionCaptures = new Map<string, SessionCapture>();
        for (const sessionId of sessionIds) {
            const entry = sessionEntries.get(sessionId);
            if (entry === undefined) continue;
            sessionCaptures.set(sessionId, {
                elements: entry.store.elements(),
                entry,
                session: entry.store.session(),
            });
        }
        const groupCapture: GroupCapture | undefined =
            groupsEntry === undefined || (!affectsGroups && relevant.length === 0)
                ? undefined
                : {
                      entry: groupsEntry,
                      projects: groupsEntry.store.projects(),
                      state: groupsEntry.store.state(),
                  };

        for (const mutation of [...relevant].reverse()) mutation.undo();
        const output = authoritative();
        acknowledge(mutationId);
        for (const mutation of pendingOverlays) {
            if (keys.has(mutation.entityKey)) mutation.undo = mutation.applyOptimistic(false);
        }

        for (const [sessionId, capture] of sessionCaptures) {
            const semantic: ChatDelta[] = [...(output.sessionDeltas?.get(sessionId) ?? [])].filter(
                (delta) => delta.type !== "elements_changed" && delta.type !== "session_changed",
            );
            if (capture.entry.store.session() !== capture.session) {
                semantic.push({
                    session: capture.entry.store.session(),
                    type: "session_changed",
                });
            }
            if (capture.entry.store.elements() !== capture.elements) {
                semantic.push({
                    elements: capture.entry.store.elements(),
                    type: "elements_changed",
                });
            }
            publishSession(capture.entry, semantic);
        }
        for (const [sessionId, deltas] of output.sessionDeltas ?? []) {
            if (!sessionCaptures.has(sessionId)) {
                const entry = sessionEntries.get(sessionId);
                if (entry !== undefined) publishSession(entry, deltas);
            }
        }

        if (groupCapture !== undefined) {
            const semantic: GroupDelta[] = [...(output.groupDeltas ?? [])].filter(
                (delta) =>
                    delta.type !== "projects_changed" && delta.type !== "groups_state_changed",
            );
            if (groupCapture.entry.store.state() !== groupCapture.state) {
                semantic.unshift({
                    state: groupCapture.entry.store.state(),
                    type: "groups_state_changed",
                });
            }
            if (groupCapture.entry.store.projects() !== groupCapture.projects) {
                semantic.unshift({
                    projects: groupCapture.entry.store.projects(),
                    type: "projects_changed",
                });
            }
            publishGroups(groupCapture.entry, semantic);
        } else if (output.groupDeltas !== undefined && groupsEntry !== undefined) {
            publishGroups(groupsEntry, output.groupDeltas);
        }
    };

    const currentSessionCursor = (sessionId: string): string | undefined =>
        knownSessionCursors.get(sessionId) ??
        sessionEntries.get(sessionId)?.store.session().lastEventId ??
        groupsEntry?.store.sessionSummary(sessionId)?.lastEventId;

    const groupVersion = (target: GroupTarget): number | undefined =>
        knownGroupVersions.get(groupKey(target)) ?? groupsEntry?.store.groupVersion(target);

    const rememberSessionCursor = (sessionId: string, cursor: string): void => {
        const known = knownSessionCursors.get(sessionId);
        if (known === undefined || known < cursor) knownSessionCursors.set(sessionId, cursor);
    };

    const rememberGroupVersion = (key: string, version: number): void => {
        const known = knownGroupVersions.get(key);
        if (known === undefined || known < version) knownGroupVersions.set(key, version);
    };

    const recordAcceptedResponse = (mutation: PendingMutation, data: unknown): void => {
        if (data === null || typeof data !== "object") return;
        const value = data as {
            eventId?: unknown;
            project?: { version?: unknown };
            session?: { lastEventId?: unknown };
            workspace?: { version?: unknown };
        };
        if (mutation.sessionId !== undefined) {
            const cursor =
                typeof value.session?.lastEventId === "string"
                    ? value.session.lastEventId
                    : typeof value.eventId === "string"
                      ? value.eventId
                      : undefined;
            if (cursor !== undefined) rememberSessionCursor(mutation.sessionId, cursor);
        }
        const version = value.project?.version ?? value.workspace?.version;
        if (typeof version === "number") rememberGroupVersion(mutation.entityKey, version);
    };

    const applyAcceptedResponse = (mutation: PendingMutation, data: unknown): boolean => {
        const project = responseEntity(data, "project");
        if (
            groupsEntry !== undefined &&
            typeof project?.id === "string" &&
            typeof project.version === "number"
        ) {
            const entry = groupsEntry;
            const event = {
                createdAt: now(),
                data: { mutationId: mutation.id, project: project as unknown as Project },
                id: mutation.id,
                projectId: project.id,
                type: "project_updated",
            } as GlobalEvent;
            reconcile([mutation.entityKey], mutation.id, [], true, () => ({
                groupDeltas: entry.store.apply(event),
            }));
            return true;
        }

        const workspace = responseEntity(data, "workspace");
        if (
            groupsEntry !== undefined &&
            typeof workspace?.id === "string" &&
            typeof workspace.projectId === "string" &&
            typeof workspace.version === "number"
        ) {
            const entry = groupsEntry;
            const event = {
                createdAt: now(),
                data: {
                    mutationId: mutation.id,
                    workspace: workspace as unknown as ProjectWorkspace,
                },
                id: mutation.id,
                projectId: workspace.projectId,
                type: "workspace_updated",
                workspaceId: workspace.id,
            } as GlobalEvent;
            reconcile([mutation.entityKey], mutation.id, [], true, () => ({
                groupDeltas: entry.store.apply(event),
            }));
            return true;
        }

        const session = responseEntity(data, "session");
        if (
            mutation.sessionId !== undefined &&
            isProtocolSessionResponse(session) &&
            sessionEntries.has(mutation.sessionId)
        ) {
            const event: SessionEvent = {
                createdAt: now(),
                data: { session },
                id: typeof session.lastEventId === "string" ? session.lastEventId : mutation.id,
                sessionId: mutation.sessionId,
                type: "session_updated",
            };
            reconcile(
                [mutation.entityKey],
                mutation.id,
                [mutation.sessionId],
                groupsEntry !== undefined,
                () => ({
                    ...(groupsEntry === undefined
                        ? {}
                        : { groupDeltas: groupsEntry.store.apply(event) }),
                    sessionDeltas: new Map([
                        [
                            mutation.sessionId as string,
                            sessionEntries
                                .get(mutation.sessionId as string)
                                ?.store.applySessionSnapshot(session) ?? [],
                        ],
                    ]),
                }),
            );
            return true;
        }
        return false;
    };

    const applyAuthoritativeResponseDirectly = (
        mutation: PendingMutation,
        data: unknown,
    ): ReconcileOutput => {
        const project = responseEntity(data, "project");
        if (
            groupsEntry !== undefined &&
            typeof project?.id === "string" &&
            typeof project.version === "number"
        ) {
            const event = {
                createdAt: now(),
                data: { project: project as unknown as Project },
                id: mutation.id,
                projectId: project.id,
                type: "project_updated",
            } as GlobalEvent;
            return { groupDeltas: groupsEntry.store.apply(event) };
        }
        const workspace = responseEntity(data, "workspace");
        if (
            groupsEntry !== undefined &&
            typeof workspace?.id === "string" &&
            typeof workspace.projectId === "string" &&
            typeof workspace.version === "number"
        ) {
            const event = {
                createdAt: now(),
                data: { workspace: workspace as unknown as ProjectWorkspace },
                id: mutation.id,
                projectId: workspace.projectId,
                type: "workspace_updated",
                workspaceId: workspace.id,
            } as GlobalEvent;
            return { groupDeltas: groupsEntry.store.apply(event) };
        }
        const session = responseEntity(data, "session");
        if (mutation.sessionId !== undefined && isProtocolSessionResponse(session)) {
            const event: SessionEvent = {
                createdAt: now(),
                data: { session },
                id: typeof session.lastEventId === "string" ? session.lastEventId : mutation.id,
                sessionId: mutation.sessionId,
                type: "session_updated",
            };
            const entry = sessionEntries.get(mutation.sessionId);
            return {
                ...(groupsEntry === undefined
                    ? {}
                    : { groupDeltas: groupsEntry.store.apply(event) }),
                ...(entry === undefined
                    ? {}
                    : {
                          sessionDeltas: new Map([
                              [mutation.sessionId, entry.store.applySessionSnapshot(session)],
                          ]),
                      }),
            };
        }
        return {};
    };

    const rejectMutation = (
        mutation: PendingMutation,
        message: string,
        authoritativeData?: unknown,
    ): void => {
        const sameEntity = pendingOverlays.filter(
            (candidate) => candidate.entityKey === mutation.entityKey,
        );
        const sessionIds = new Set(
            sameEntity.flatMap((candidate) =>
                candidate.sessionId === undefined ? [] : [candidate.sessionId],
            ),
        );
        const captures = new Map<string, SessionCapture>();
        for (const sessionId of sessionIds) {
            const entry = sessionEntries.get(sessionId);
            if (entry === undefined) continue;
            captures.set(sessionId, {
                elements: entry.store.elements(),
                entry,
                session: entry.store.session(),
            });
        }
        const groupCapture =
            groupsEntry === undefined
                ? undefined
                : {
                      entry: groupsEntry,
                      projects: groupsEntry.store.projects(),
                      state: groupsEntry.store.state(),
                  };
        for (const candidate of [...sameEntity].reverse()) candidate.undo();
        const index = pendingOverlays.indexOf(mutation);
        if (index >= 0) pendingOverlays.splice(index, 1);
        const authoritative = applyAuthoritativeResponseDirectly(mutation, authoritativeData);
        for (const candidate of pendingOverlays) {
            if (candidate.entityKey === mutation.entityKey) {
                candidate.undo = candidate.applyOptimistic(false);
            }
        }

        const rejection: MutationRejectedDelta = {
            action: mutation.action,
            message,
            mutationId: mutation.id,
            type: "mutation_rejected",
        };
        for (const capture of captures.values()) {
            const deltas: ChatDelta[] = [
                ...(authoritative.sessionDeltas?.get(capture.entry.store.session().sessionId) ??
                    []),
                rejection,
            ].filter(
                (delta) => delta.type !== "elements_changed" && delta.type !== "session_changed",
            );
            if (capture.entry.store.session() !== capture.session) {
                deltas.unshift({
                    session: capture.entry.store.session(),
                    type: "session_changed",
                });
            }
            if (capture.entry.store.elements() !== capture.elements) {
                deltas.unshift({
                    elements: capture.entry.store.elements(),
                    type: "elements_changed",
                });
            }
            publishSession(capture.entry, deltas);
        }
        if (groupCapture !== undefined) {
            const deltas: GroupDelta[] = [...(authoritative.groupDeltas ?? []), rejection].filter(
                (delta) =>
                    delta.type !== "projects_changed" && delta.type !== "groups_state_changed",
            );
            if (groupCapture.entry.store.projects() !== groupCapture.projects) {
                deltas.unshift({
                    projects: groupCapture.entry.store.projects(),
                    type: "projects_changed",
                });
            }
            publishGroups(groupCapture.entry, deltas);
        }
    };

    const performMutation = async (
        mutation: PendingMutation,
        signal: AbortSignal,
    ): Promise<unknown> => {
        const prepared = mutation.prepare();
        const headers: Record<string, string> = {
            accept: "application/json",
            authorization: `Bearer ${options.token}`,
            ...prepared.headers,
        };
        if (prepared.body !== undefined) headers["content-type"] = "application/json";
        const response = await request(prepared.url, {
            ...(prepared.body === undefined ? {} : { body: JSON.stringify(prepared.body) }),
            headers,
            method: prepared.method,
            signal,
        });
        const data = await readResponseBody(response);
        if (!response.ok) {
            throw new MutationHttpError(
                response.status,
                humanMutationError(data, response.status),
                retryAfterMilliseconds(response.headers.get("retry-after"), now()),
                data,
            );
        }
        return data;
    };

    const pump = async (entityKey: string): Promise<void> => {
        if (activeWorkers.has(entityKey)) return;
        activeWorkers.add(entityKey);
        let retryDelay = options.mutationRetryDelayMs ?? INITIAL_MUTATION_RETRY_MS;
        try {
            for (;;) {
                if (closed) return;
                const queue = queues.get(entityKey);
                const mutation = queue?.[0];
                if (queue === undefined || mutation === undefined) return;
                if (mutation.acknowledged) {
                    queue.shift();
                    retryDelay = options.mutationRetryDelayMs ?? INITIAL_MUTATION_RETRY_MS;
                    continue;
                }

                const controller = linkedController(rootController.signal);
                mutation.attemptController = controller.controller;
                try {
                    const data = await performMutation(mutation, controller.controller.signal);
                    if (closed) return;
                    recordAcceptedResponse(mutation, data);
                    // A successful response commits the prediction. It stays
                    // visible in the store, but is no longer an overlay that a
                    // reconnect snapshot could accidentally reapply forever.
                    if (!applyAcceptedResponse(mutation, data)) acknowledge(mutation.id);
                    queue.shift();
                    retryDelay = options.mutationRetryDelayMs ?? INITIAL_MUTATION_RETRY_MS;
                } catch (error) {
                    if (closed) return;
                    if (mutation.acknowledged) {
                        queue.shift();
                        retryDelay = options.mutationRetryDelayMs ?? INITIAL_MUTATION_RETRY_MS;
                        continue;
                    }
                    if (
                        error instanceof MutationHttpError &&
                        error.status === 409 &&
                        mutation.matchesAuthoritative?.(error.data) === true
                    ) {
                        recordAcceptedResponse(mutation, error.data);
                        acknowledge(mutation.id);
                        queue.shift();
                        retryDelay = options.mutationRetryDelayMs ?? INITIAL_MUTATION_RETRY_MS;
                        continue;
                    }
                    if (isRetryableMutationError(error)) {
                        const delay =
                            error instanceof MutationHttpError && error.retryAfterMs !== undefined
                                ? Math.min(MAXIMUM_MUTATION_RETRY_MS, error.retryAfterMs)
                                : retryDelay;
                        await wait(delay, rootController.signal);
                        retryDelay = Math.min(MAXIMUM_MUTATION_RETRY_MS, retryDelay * 2);
                        continue;
                    }
                    queue.shift();
                    rejectMutation(
                        mutation,
                        describeMutationRejection(error),
                        error instanceof MutationHttpError ? error.data : undefined,
                    );
                } finally {
                    delete mutation.attemptController;
                    controller.detach();
                }
            }
        } finally {
            activeWorkers.delete(entityKey);
            const queue = queues.get(entityKey);
            if (queue?.length === 0) queues.delete(entityKey);
            releaseUnusedEntries();
        }
    };

    const enqueue = (mutation: PendingMutation): MutationId => {
        if (closed) throw new Error("This Rig connection is closed.");
        mutation.undo = mutation.applyOptimistic(true);
        pendingOverlays.push(mutation);
        const queue = queues.get(mutation.entityKey) ?? [];
        if (!queues.has(mutation.entityKey)) queues.set(mutation.entityKey, queue);
        if (queue.length >= MAXIMUM_PENDING_PER_ENTITY) {
            rejectMutation(
                mutation,
                "Rig could not queue that change because too many changes are already pending.",
            );
            return mutation.id;
        }
        queue.push(mutation);
        void pump(mutation.entityKey);
        return mutation.id;
    };

    const createSessionEntry = (
        sessionId: string,
        transcriptTurnLimit: number | undefined,
    ): SessionEntry => {
        const known = sessionEntries.get(sessionId);
        if (known !== undefined) return known;
        const linked = linkedController(rootController.signal);
        const entry: SessionEntry = {
            controller: linked.controller,
            detachRoot: linked.detach,
            started: false,
            store: new ChatStore(sessionId),
            subscribers: new Set(),
            ...(transcriptTurnLimit === undefined ? {} : { transcriptTurnLimit }),
        };
        sessionEntries.set(sessionId, entry);
        const key = sessionKey(sessionId);
        if (pendingOverlays.some((mutation) => mutation.entityKey === key)) {
            reconcile([key], undefined, [sessionId], true, () => ({}));
        }
        return entry;
    };

    const startSessionEntry = (entry: SessionEntry): void => {
        if (entry.started) return;
        entry.started = true;
        const sessionId = entry.store.session().sessionId;
        const key = sessionKey(sessionId);
        void streamSessionEvents({
            endpoint: options.endpoint,
            fetch: request,
            sessionId,
            signal: entry.controller.signal,
            token: options.token,
            ...(options.wait === undefined ? {} : { wait }),
            ...(entry.transcriptTurnLimit === undefined
                ? {}
                : { transcriptTurnLimit: entry.transcriptTurnLimit }),
            onHello: (hello) => {
                if (hello.lastEventId !== undefined && !hello.resumed) {
                    rememberSessionCursor(sessionId, hello.lastEventId);
                }
                reconcile([key], undefined, [sessionId], true, () => ({
                    sessionDeltas: new Map([
                        [
                            sessionId,
                            [
                                ...entry.store.setConnection("live"),
                                ...entry.store.applyHello(hello),
                            ],
                        ],
                    ]),
                }));
            },
            onEvent: (event) => {
                rememberSessionCursor(sessionId, event.id);
                reconcile([key], mutationIdOf(event), [sessionId], true, () => ({
                    sessionDeltas: new Map([[sessionId, entry.store.apply(event)]]),
                }));
            },
            onDisconnected: () => {
                reconcile([key], undefined, [sessionId], false, () => ({
                    sessionDeltas: new Map([
                        [sessionId, entry.store.setConnection("reconnecting")],
                    ]),
                }));
            },
        })
            .catch((error: unknown) => {
                if (closed || entry.controller.signal.aborted) return;
                publishSession(entry, entry.store.setConnection("closed"));
                for (const subscriber of [...entry.subscribers]) subscriber.onError?.(error);
            })
            .finally(() => {
                if (!closed && !entry.controller.signal.aborted) {
                    publishSession(entry, entry.store.setConnection("closed"));
                }
            });
    };

    const createGroupEntry = (): GroupEntry => {
        if (groupsEntry !== undefined) return groupsEntry;
        const linked = linkedController(rootController.signal);
        const entry: GroupEntry = {
            controller: linked.controller,
            detachRoot: linked.detach,
            started: false,
            store: new GroupStore(),
            subscribers: new Set(),
        };
        groupsEntry = entry;
        if (pendingOverlays.length > 0) {
            reconcile(
                pendingOverlays.map((mutation) => mutation.entityKey),
                undefined,
                [],
                true,
                () => ({}),
            );
        }
        return entry;
    };

    const startGroupEntry = (entry: GroupEntry): void => {
        if (entry.started) return;
        entry.started = true;
        void streamGlobalEvents({
            endpoint: options.endpoint,
            fetch: request,
            signal: entry.controller.signal,
            token: options.token,
            ...(options.wait === undefined ? {} : { wait }),
            onHello: (hello) => {
                for (const project of hello.projects) {
                    rememberGroupVersion(projectKey(project.id), project.version);
                }
                for (const workspace of hello.workspaces) {
                    rememberGroupVersion(
                        workspaceKey(workspace.projectId, workspace.id),
                        workspace.version,
                    );
                }
                for (const session of hello.sessions) {
                    if (session.lastEventId !== undefined) {
                        rememberSessionCursor(session.id, session.lastEventId);
                    }
                }
                reconcile(
                    pendingOverlays.map((mutation) => mutation.entityKey),
                    undefined,
                    [],
                    true,
                    () => ({
                        groupDeltas: [
                            ...entry.store.setConnection("live"),
                            ...entry.store.applyHello(hello),
                        ],
                    }),
                );
            },
            onEvent: (event) => {
                rememberGlobalIdentity(event);
                const key = globalEventKey(event);
                reconcile([key], mutationIdOf(event), [], true, () => ({
                    groupDeltas: entry.store.apply(event),
                }));
            },
            onDisconnected: () => publishGroups(entry, entry.store.setConnection("reconnecting")),
        })
            .catch((error: unknown) => {
                if (closed || entry.controller.signal.aborted) return;
                publishGroups(entry, entry.store.setConnection("closed"));
                for (const subscriber of [...entry.subscribers]) subscriber.onError?.(error);
            })
            .finally(() => {
                if (!closed && !entry.controller.signal.aborted) {
                    publishGroups(entry, entry.store.setConnection("closed"));
                }
            });
    };

    const rememberGlobalIdentity = (event: GlobalEvent): void => {
        if (
            event.type !== "session_current" &&
            "sessionId" in event &&
            typeof event.sessionId === "string"
        ) {
            rememberSessionCursor(event.sessionId, event.id);
        }
        if (event.type === "project_created" || event.type === "project_updated") {
            const project = (event.data as { project: { id: string; version: number } }).project;
            rememberGroupVersion(projectKey(project.id), project.version);
        }
        if (event.type === "workspace_created" || event.type === "workspace_updated") {
            const workspace = (
                event.data as {
                    workspace: { id: string; projectId: string; version: number };
                }
            ).workspace;
            rememberGroupVersion(
                workspaceKey(workspace.projectId, workspace.id),
                workspace.version,
            );
        }
        if (event.type === "session_current") {
            const session = (event.data as { session: { id: string; lastEventId?: string } })
                .session;
            if (session.lastEventId !== undefined) {
                rememberSessionCursor(session.id, session.lastEventId);
            }
        }
    };

    const releaseUnusedEntries = (): void => {
        for (const [sessionId, entry] of sessionEntries) {
            const key = sessionKey(sessionId);
            if (
                entry.subscribers.size > 0 ||
                pendingOverlays.some((mutation) => mutation.entityKey === key) ||
                (queues.get(key)?.length ?? 0) > 0
            ) {
                continue;
            }
            entry.controller.abort();
            entry.detachRoot();
            sessionEntries.delete(sessionId);
        }
        if (
            groupsEntry !== undefined &&
            groupsEntry.subscribers.size === 0 &&
            pendingOverlays.length === 0 &&
            queues.size === 0
        ) {
            groupsEntry.controller.abort();
            groupsEntry.detachRoot();
            groupsEntry = undefined;
        }
    };

    const connectSession = (subscription: RigSessionSubscriptionOptions): RigSessionConnection => {
        if (closed) throw new Error("This Rig connection is closed.");
        const entry = createSessionEntry(subscription.sessionId, subscription.transcriptTurnLimit);
        const subscriber: SessionSubscriber = { ...subscription, closed: false };
        entry.subscribers.add(subscriber);
        subscriber.onChange(entry.store.elements(), entry.store.session());
        startSessionEntry(entry);

        const loadMore = (token: string): void => {
            if (closed || subscriber.closed) return;
            const started = entry.store.startLoadingMore(token);
            if (started === undefined) return;
            publishSession(entry, started.deltas);
            void fetchEarlier(
                options.endpoint,
                options.token,
                subscription.sessionId,
                started.anchor.before,
                request,
                entry.controller.signal,
            )
                .then((page) => {
                    if (closed || entry.controller.signal.aborted) return;
                    publishSession(entry, entry.store.prependEarlier(page, started.anchor));
                })
                .catch((error: unknown) => {
                    if (closed || entry.controller.signal.aborted) return;
                    publishSession(
                        entry,
                        entry.store.failLoadingMore(started.anchor, describeLoadFailure(error)),
                    );
                });
        };

        return {
            elements: () => entry.store.elements(),
            loadMore,
            session: () => entry.store.session(),
            close: () => {
                if (subscriber.closed) return;
                subscriber.closed = true;
                entry.subscribers.delete(subscriber);
                releaseUnusedEntries();
            },
        };
    };

    const connectGroups = (subscription: RigGroupsSubscriptionOptions): RigGroupsConnection => {
        if (closed) throw new Error("This Rig connection is closed.");
        const entry = createGroupEntry();
        const subscriber: GroupSubscriber = { ...subscription, closed: false };
        entry.subscribers.add(subscriber);
        subscriber.onChange(entry.store.projects(), entry.store.state());
        startGroupEntry(entry);
        return {
            projects: () => entry.store.projects(),
            remoteTerminals: () => entry.store.remoteTerminals(),
            state: () => entry.store.state(),
            close: () => {
                if (subscriber.closed) return;
                subscriber.closed = true;
                entry.subscribers.delete(subscriber);
                releaseUnusedEntries();
            },
        };
    };

    const sendMessage = (sessionId: string, message: string | SendMessageInput): MutationId => {
        const input = typeof message === "string" ? { text: message } : message;
        const id = nextMutationId();
        const key = sessionKey(sessionId);
        let expectedEventId: string | undefined;
        const mutation: PendingMutation = {
            acknowledged: false,
            action: "send_message",
            entityKey: key,
            id,
            sessionId,
            undo: () => undefined,
            applyOptimistic: (publish) => {
                const undos: (() => void)[] = [];
                const entry = sessionEntries.get(sessionId);
                if (entry !== undefined) {
                    const changed = entry.store.applyOptimisticMessage(id, input.text, now());
                    undos.push(changed.undo);
                    if (publish) publishSession(entry, changed.deltas);
                }
                if (groupsEntry !== undefined) {
                    const changed = groupsEntry.store.applyOptimisticSessionPatch(sessionId, {
                        lastMessageAt: now(),
                        status: "queued",
                    });
                    undos.push(changed.undo);
                    if (publish) publishGroups(groupsEntry, changed.deltas);
                }
                return composeUndo(undos);
            },
            prepare: () => {
                expectedEventId ??= currentSessionCursor(sessionId);
                return {
                    body: {
                        clientSubmissionId: id,
                        ...(input.content === undefined ? {} : { content: input.content }),
                        ...(input.displayText === undefined
                            ? {}
                            : { displayText: input.displayText }),
                        mutationId: id,
                        text: input.text,
                    },
                    headers: ifMatchHeader(expectedEventId),
                    method: "POST",
                    url: endpointUrl(
                        options.endpoint,
                        `sessions/${encodeURIComponent(sessionId)}/messages`,
                    ),
                };
            },
        };
        return enqueue(mutation);
    };

    const stopRun = (sessionId: string): MutationId => {
        const id = nextMutationId();
        const key = sessionKey(sessionId);
        const expectedRunId = sessionEntries.get(sessionId)?.store.session().activeTurn?.turnId;
        let expectedEventId: string | undefined;
        const mutation: PendingMutation = {
            acknowledged: false,
            action: "stop_run",
            entityKey: key,
            id,
            sessionId,
            undo: () => undefined,
            applyOptimistic: (publish) => {
                const undos: (() => void)[] = [];
                const entry = sessionEntries.get(sessionId);
                if (entry !== undefined) {
                    const current = entry.store.session();
                    const changed = entry.store.applyOptimisticSession({
                        activity: {
                            kind: "stopped",
                            label: "Stopping",
                            ...(current.activeTurn === undefined
                                ? {}
                                : { runId: current.activeTurn.turnId }),
                            since: now(),
                        },
                    });
                    undos.push(changed.undo);
                    if (publish) publishSession(entry, changed.deltas);
                }
                if (groupsEntry !== undefined) {
                    const changed = groupsEntry.store.applyOptimisticSessionPatch(sessionId, {
                        status: "aborted",
                    });
                    undos.push(changed.undo);
                    if (publish) publishGroups(groupsEntry, changed.deltas);
                }
                return composeUndo(undos);
            },
            prepare: () => {
                expectedEventId ??= currentSessionCursor(sessionId);
                const query =
                    expectedRunId === undefined
                        ? ""
                        : `?expectedRunId=${encodeURIComponent(expectedRunId)}`;
                return {
                    headers: {
                        ...ifMatchHeader(expectedEventId),
                        "x-rig-mutation-id": id,
                    },
                    method: "POST",
                    url: endpointUrl(
                        options.endpoint,
                        `sessions/${encodeURIComponent(sessionId)}/abort${query}`,
                    ),
                };
            },
        };
        return enqueue(mutation);
    };

    const switchModel = (sessionId: string, selection: string | ModelSelection): MutationId => {
        const selected = typeof selection === "string" ? { modelId: selection } : selection;
        const id = nextMutationId();
        const key = sessionKey(sessionId);
        let expectedEventId: string | undefined;
        const mutation: PendingMutation = {
            acknowledged: false,
            action: "switch_model",
            entityKey: key,
            id,
            sessionId,
            undo: () => undefined,
            applyOptimistic: (publish) => {
                const undos: (() => void)[] = [];
                const entry = sessionEntries.get(sessionId);
                if (entry !== undefined) {
                    const changed = entry.store.applyOptimisticSession({
                        modelId: selected.modelId,
                        ...(selected.providerId === undefined
                            ? {}
                            : { providerId: selected.providerId }),
                    });
                    undos.push(changed.undo);
                    if (publish) publishSession(entry, changed.deltas);
                }
                if (groupsEntry !== undefined) {
                    const changed = groupsEntry.store.applyOptimisticSessionPatch(sessionId, {
                        modelId: selected.modelId,
                        ...(selected.providerId === undefined
                            ? {}
                            : { providerId: selected.providerId }),
                    });
                    undos.push(changed.undo);
                    if (publish) publishGroups(groupsEntry, changed.deltas);
                }
                return composeUndo(undos);
            },
            prepare: () => {
                expectedEventId ??= currentSessionCursor(sessionId);
                return {
                    body: { ...selected, mutationId: id },
                    headers: ifMatchHeader(expectedEventId),
                    method: "PATCH",
                    url: endpointUrl(
                        options.endpoint,
                        `sessions/${encodeURIComponent(sessionId)}/model`,
                    ),
                };
            },
            matchesAuthoritative: (data) => {
                const session = responseEntity(data, "session");
                return (
                    session?.modelId === selected.modelId &&
                    (selected.providerId === undefined ||
                        session.providerId === selected.providerId)
                );
            },
        };
        return enqueue(mutation);
    };

    const setSessionArchived = (sessionId: string, archived: boolean): MutationId => {
        const id = nextMutationId();
        const key = sessionKey(sessionId);
        let expectedEventId: string | undefined;
        const mutation: PendingMutation = {
            acknowledged: false,
            action: "set_session_archived",
            entityKey: key,
            id,
            sessionId,
            undo: () => undefined,
            applyOptimistic: (publish) => {
                const undos: (() => void)[] = [];
                const entry = sessionEntries.get(sessionId);
                if (entry !== undefined) {
                    const changed = entry.store.applyOptimisticSession({ archived });
                    undos.push(changed.undo);
                    if (publish) publishSession(entry, changed.deltas);
                }
                if (groupsEntry !== undefined) {
                    const changed = groupsEntry.store.applyOptimisticSessionArchived(
                        sessionId,
                        archived,
                    );
                    undos.push(changed.undo);
                    if (publish) publishGroups(groupsEntry, changed.deltas);
                }
                return composeUndo(undos);
            },
            prepare: () => {
                expectedEventId ??= currentSessionCursor(sessionId);
                return {
                    headers: {
                        ...ifMatchHeader(expectedEventId),
                        "x-rig-mutation-id": id,
                    },
                    method: "POST",
                    url: endpointUrl(
                        options.endpoint,
                        `sessions/${encodeURIComponent(sessionId)}/${archived ? "archive" : "unarchive"}`,
                    ),
                };
            },
            matchesAuthoritative: (data) => responseEntity(data, "session")?.archived === archived,
        };
        return enqueue(mutation);
    };

    const renameGroup = (target: GroupTarget, name: string): MutationId => {
        const id = nextMutationId();
        const key = groupKey(target);
        let expectedVersion: number | undefined;
        const mutation: PendingMutation = {
            acknowledged: false,
            action: "rename_group",
            entityKey: key,
            id,
            undo: () => undefined,
            applyOptimistic: (publish) => {
                if (groupsEntry === undefined) return () => undefined;
                const changed = groupsEntry.store.applyOptimisticGroupName(target, name);
                if (publish) publishGroups(groupsEntry, changed.deltas);
                return changed.undo;
            },
            prepare: () => {
                expectedVersion ??= groupVersion(target);
                const path =
                    target.kind === "project"
                        ? `projects/${encodeURIComponent(target.projectId)}`
                        : `projects/${encodeURIComponent(target.projectId)}/workspaces/${encodeURIComponent(target.workspaceId)}`;
                return {
                    body: { mutationId: id, name },
                    headers: ifMatchHeader(expectedVersion),
                    method: "PATCH",
                    url: endpointUrl(options.endpoint, path),
                };
            },
            matchesAuthoritative: (data) =>
                responseEntity(data, target.kind === "project" ? "project" : "workspace")?.name ===
                name,
        };
        return enqueue(mutation);
    };

    return {
        close: () => {
            if (closed) return;
            closed = true;
            rootController.abort();
            for (const mutation of [...pendingOverlays].reverse()) mutation.undo();
            pendingOverlays.length = 0;
            queues.clear();
            for (const entry of sessionEntries.values()) {
                entry.controller.abort();
                entry.detachRoot();
                entry.subscribers.clear();
            }
            sessionEntries.clear();
            if (groupsEntry !== undefined) {
                groupsEntry.controller.abort();
                groupsEntry.detachRoot();
                groupsEntry.subscribers.clear();
                groupsEntry = undefined;
            }
        },
        connectGroups,
        connectSession,
        renameGroup,
        sendMessage,
        setSessionArchived,
        stopRun,
        switchModel,
    };
}

function sessionKey(sessionId: string): string {
    return `session:${sessionId}`;
}

function projectKey(projectId: string): string {
    return `project:${projectId}`;
}

function workspaceKey(projectId: string, workspaceId: string): string {
    return `workspace:${projectId}:${workspaceId}`;
}

function groupKey(target: GroupTarget): string {
    return target.kind === "project"
        ? projectKey(target.projectId)
        : workspaceKey(target.projectId, target.workspaceId);
}

function globalEventKey(event: GlobalEvent): string {
    if ("sessionId" in event && typeof event.sessionId === "string") {
        return sessionKey(event.sessionId);
    }
    const scoped = event as { projectId: string; workspaceId?: string };
    if (scoped.workspaceId !== undefined) {
        return workspaceKey(scoped.projectId, scoped.workspaceId);
    }
    return projectKey(scoped.projectId);
}

function mutationIdOf(event: SessionEvent | GlobalEvent): string | undefined {
    if (event.data === null || typeof event.data !== "object") return undefined;
    const mutationId = (event.data as { mutationId?: unknown }).mutationId;
    return typeof mutationId === "string" ? mutationId : undefined;
}

function endpointUrl(endpoint: string, path: string): string {
    return new URL(path, endpoint.endsWith("/") ? endpoint : `${endpoint}/`).toString();
}

function ifMatchHeader(value: string | number | undefined): Record<string, string> {
    return value === undefined ? {} : { "if-match": JSON.stringify(String(value)) };
}

function composeUndo(undos: readonly (() => void)[]): () => void {
    return () => {
        for (const undo of [...undos].reverse()) undo();
    };
}

function linkedController(parent: AbortSignal): {
    controller: AbortController;
    detach: () => void;
} {
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (parent.aborted) controller.abort();
    else parent.addEventListener("abort", abort, { once: true });
    return {
        controller,
        detach: () => parent.removeEventListener("abort", abort),
    };
}

async function readResponseBody(response: Response): Promise<unknown> {
    const text = await response.text();
    if (text.length === 0) return undefined;
    try {
        return JSON.parse(text) as unknown;
    } catch {
        return text;
    }
}

class MutationHttpError extends Error {
    readonly data: unknown;
    readonly retryAfterMs: number | undefined;
    readonly status: number;

    constructor(status: number, message: string, retryAfterMs: number | undefined, data?: unknown) {
        super(message);
        this.name = "MutationHttpError";
        this.status = status;
        this.retryAfterMs = retryAfterMs;
        this.data = data;
    }
}

function isRetryableMutationError(error: unknown): boolean {
    if (!(error instanceof MutationHttpError)) {
        return !(error instanceof DOMException && error.name === "AbortError");
    }
    return (
        error.status === 408 || error.status === 425 || error.status === 429 || error.status >= 500
    );
}

function retryAfterMilliseconds(value: string | null, currentTime: number): number | undefined {
    if (value === null) return undefined;
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
    const date = Date.parse(value);
    return Number.isFinite(date) ? Math.max(0, date - currentTime) : undefined;
}

function humanMutationError(data: unknown, status: number): string {
    if (
        data !== null &&
        typeof data === "object" &&
        typeof (data as { error?: unknown }).error === "string"
    ) {
        return (data as { error: string }).error;
    }
    return `Rig rejected the change with status ${String(status)}.`;
}

function describeMutationRejection(error: unknown): string {
    if (error instanceof Error && error.message.length > 0) return error.message;
    return "Rig could not apply that change.";
}

function responseEntity(
    data: unknown,
    key: "project" | "session" | "workspace",
): Record<string, unknown> | undefined {
    if (data === null || typeof data !== "object") return undefined;
    const entity = (data as Record<string, unknown>)[key];
    return entity !== null && typeof entity === "object"
        ? (entity as Record<string, unknown>)
        : undefined;
}

function isProtocolSessionResponse(
    value: Record<string, unknown> | undefined,
): value is Record<string, unknown> & ProtocolSession {
    return (
        typeof value?.id === "string" &&
        typeof value.archived === "boolean" &&
        typeof value.cwd === "string" &&
        typeof value.modelId === "string" &&
        typeof value.projectId === "string" &&
        typeof value.providerId === "string" &&
        typeof value.status === "string"
    );
}

function defaultWait(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
        if (signal.aborted) {
            resolve();
            return;
        }
        const timer = setTimeout(finish, ms);
        function finish(): void {
            clearTimeout(timer);
            signal.removeEventListener("abort", finish);
            resolve();
        }
        signal.addEventListener("abort", finish, { once: true });
    });
}

async function fetchEarlier(
    endpoint: string,
    token: string,
    sessionId: string,
    before: string,
    request: typeof globalThis.fetch,
    signal: AbortSignal,
): Promise<SessionTranscriptWindow> {
    const url = endpointUrl(
        endpoint,
        `sessions/${encodeURIComponent(sessionId)}/transcript?before=${encodeURIComponent(before)}`,
    );
    const response = await request(url, {
        headers: { authorization: `Bearer ${token}` },
        signal,
    });
    if (!response.ok) {
        throw new Error(
            response.status === 409
                ? "That part of the conversation is no longer available."
                : `Rig answered with ${String(response.status)}.`,
        );
    }
    return (await response.json()) as SessionTranscriptWindow;
}

function describeLoadFailure(error: unknown): string {
    if (error instanceof Error && error.message.length > 0) return error.message;
    return "Earlier messages could not be loaded.";
}
