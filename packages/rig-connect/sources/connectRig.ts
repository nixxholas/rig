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
import type { InboxDelta, InboxItem, InboxState } from "./InboxElement.js";
import { InboxStore } from "./InboxStore.js";
import { mergeForwardTranscriptWindow } from "./mergeTranscriptWindow.js";
import type {
    ProviderUsageDelta,
    ProviderUsageEntry,
    ProviderUsageState,
} from "./ProviderUsageElement.js";
import { ProviderUsageStore } from "./ProviderUsageStore.js";
import type { TimelineAgentNode, TimelineDelta, TimelineState } from "./TimelineElement.js";
import { TimelineStore } from "./TimelineStore.js";
import { createCuid2 } from "./createCuid2.js";
import { orderedUuidV7, type RandomValues } from "./orderedUuidV7.js";
import {
    CHECKING_SERVER_COMPATIBILITY,
    describeServerCompatibility,
    serverCompatibility,
    type ServerCompatibility,
} from "./ServerCompatibility.js";
import type {
    ContentBlock,
    BackgroundProcessSnapshot,
    ExternalToolCallResolution,
    GitChangeSnapshot,
    GitWatchResponse,
    GlobalEvent,
    MutationId,
    Project,
    ProjectWorkspace,
    ProtocolSession,
    RemoteTerminalGroupState,
    SessionEvent,
    SessionTranscriptWindow,
    SessionUnreadReason,
    SessionUnreadState,
    GlobalStreamHello,
    GetTimelineResponse,
    ListProviderUsageResponse,
    SessionStateResponse,
    TimelineScope,
} from "./protocol.js";
import { streamLiveEvents } from "./streamLiveEvents.js";

const INITIAL_MUTATION_RETRY_MS = 100;
const MAXIMUM_MUTATION_RETRY_MS = 5_000;
const MAXIMUM_PENDING_PER_ENTITY = 256;
const MAXIMUM_BUFFERED_SESSION_EVENTS = 1_000;
/** Well inside the fifteen minutes the daemon refreshes provider usage on. */
const DEFAULT_PROVIDER_USAGE_REFRESH_MS = 60_000;
const GIT_WATCH_RENEWAL_MS = 4 * 60 * 1_000;
const GIT_WATCH_RETRY_MS = 5_000;

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
    /** Receives rejected actions even when their entity has no active subscriber. */
    onMutationRejected?: (delta: MutationRejectedDelta) => void;
    /** Reports the result of the daemon protocol handshake. */
    onCompatibilityChange?: (compatibility: ServerCompatibility) => void;
    /**
     * Fires the moment a chat starts waiting for the person.
     *
     * This is the notification an interface plays a sound for, so it reports the
     * transition rather than the state: a chat already waiting does not announce
     * itself again, and one that stops working after asking a question announces
     * only the question. It comes off the shared stream, so it arrives whether or
     * not a view is subscribed to that chat, and reports only chats the daemon
     * tracks unread state for.
     */
    onSessionFinished?: (finished: SessionFinished) => void;
}

/** A chat that has just started waiting for the person. */
export interface SessionFinished {
    projectId: string;
    reason: SessionUnreadReason;
    sessionId: string;
    /** When it started waiting, from the event that caused it. */
    since: number;
    workspaceId?: string;
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

export interface RigInboxSubscriptionOptions {
    onChange: (items: readonly InboxItem[], state: InboxState) => void;
    onDelta?: (delta: InboxDelta) => void;
    onError?: (error: unknown) => void;
}

export interface RigProviderUsageSubscriptionOptions {
    onChange: (providers: readonly ProviderUsageEntry[], state: ProviderUsageState) => void;
    onDelta?: (delta: ProviderUsageDelta) => void;
    onError?: (error: unknown) => void;
    /**
     * How often to read the daemon again. Defaults to a minute, which is well
     * inside the fifteen minutes the daemon itself refreshes on, so a view sees
     * a new reading shortly after the daemon takes one.
     */
    refreshIntervalMs?: number;
}

export interface RigTimelineSubscriptionOptions {
    /** Leave archived chats out, as the daemon does by default. */
    includeArchived?: boolean;
    onChange: (agents: readonly TimelineAgentNode[], state: TimelineState) => void;
    onDelta?: (delta: TimelineDelta) => void;
    onError?: (error: unknown) => void;
    scope: TimelineScope;
    /** Drop work that had already finished by this moment, in milliseconds. */
    since?: number;
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

export interface RigInboxConnection {
    items: () => readonly InboxItem[];
    state: () => InboxState;
    close: () => void;
}

export interface RigProviderUsageConnection {
    providers: () => readonly ProviderUsageEntry[];
    state: () => ProviderUsageState;
    /** Reads the daemon now and restarts the interval from this moment. */
    refresh: () => Promise<void>;
    close: () => void;
}

export interface RigTimelineConnection {
    agents: () => readonly TimelineAgentNode[];
    state: () => TimelineState;
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

export interface DraftUpdate {
    draft: string | null;
    origin?: string;
    updatedAt?: number;
}

export interface UserInputAnswers {
    answers: Readonly<Record<string, readonly string[]>>;
}

export type GoalStatus = "active" | "blocked" | "complete" | "paused";
export type SecretAttachmentScope = "project" | "session";

export interface ShellCommandInput {
    command: string;
    commandId: string;
}

export interface CreateSessionInput {
    appendSystemPrompt?: string;
    cwd: string;
    effort?: string;
    local?: boolean;
    modelId?: string;
    permissionMode?: string;
    /**
     * Identity to give the project if this directory is not one yet.
     *
     * A directory that Rig already knows keeps the identity it has, so this
     * names an import rather than asserting which project the session lands in.
     */
    projectId?: string;
    providerId?: string;
    secretIds?: readonly string[];
    serviceTier?: string;
    trackUnread?: boolean;
    workflowsEnabled?: boolean;
    workspaceId?: string;
}

export interface CreateWorkspaceInput {
    /** Explicit base to fork; the project's main branch on the remote is used when it is absent. */
    baseRef?: string;
    name: string;
    projectId: string;
}

export interface TerminalPresence {
    connectionId: string;
    close: () => Promise<void>;
    setFocused: (focused: boolean) => Promise<void>;
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
    /** Current result of the daemon protocol handshake. */
    compatibility: () => ServerCompatibility;
    connectSession: (options: RigSessionSubscriptionOptions) => RigSessionConnection;
    connectGroups: (options: RigGroupsSubscriptionOptions) => RigGroupsConnection;
    connectInbox: (options: RigInboxSubscriptionOptions) => RigInboxConnection;
    /**
     * Follows how much of each provider account's plan has been used.
     *
     * Usage is polled rather than streamed, so this subscription reads the
     * daemon itself and repeats on an interval for as long as a view is
     * mounted. It reports a loading state until the first answer arrives.
     */
    connectProviderUsage: (
        options: RigProviderUsageSubscriptionOptions,
    ) => RigProviderUsageConnection;
    connectTimeline: (options: RigTimelineSubscriptionOptions) => RigTimelineConnection;
    /** Returns the workspace's own identity, which is also this action's identity. */
    createWorkspace: (input: CreateWorkspaceInput) => MutationId;
    archiveWorkspace: (projectId: string, workspaceId: string) => MutationId;
    /** Returns the session's own identity, which is also this action's identity. */
    createSession: (input: CreateSessionInput) => MutationId;
    forkSession: (sessionId: string) => MutationId;
    /** Clears a chat's unread state, the way focusing a terminal on it does. */
    markSessionRead: (sessionId: string) => MutationId;
    sendMessage: (sessionId: string, message: string | SendMessageInput) => MutationId;
    stopRun: (sessionId: string) => MutationId;
    switchModel: (sessionId: string, selection: string | ModelSelection) => MutationId;
    setEffort: (sessionId: string, effort?: string) => MutationId;
    setServiceTier: (sessionId: string, serviceTier?: string) => MutationId;
    setPermissionMode: (sessionId: string, permissionMode: string) => MutationId;
    setDraft: (sessionId: string, update: string | DraftUpdate) => MutationId;
    setAppendSystemPrompt: (sessionId: string, prompt: string | null) => MutationId;
    answerUserInput: (
        sessionId: string,
        requestId: string,
        response: UserInputAnswers,
    ) => MutationId;
    setGoal: (sessionId: string, objective: string) => MutationId;
    setGoalStatus: (sessionId: string, status: GoalStatus) => MutationId;
    clearGoal: (sessionId: string) => MutationId;
    attachSecret: (
        sessionId: string,
        secretId: string,
        scope?: SecretAttachmentScope,
    ) => MutationId;
    detachSecret: (
        sessionId: string,
        secretId: string,
        scope?: SecretAttachmentScope,
    ) => MutationId;
    compactSession: (sessionId: string) => MutationId;
    resetSession: (sessionId: string) => MutationId;
    rewindSession: (sessionId: string, messageId: string) => MutationId;
    runShellCommand: (sessionId: string, input: ShellCommandInput) => MutationId;
    stopWorkflow: (sessionId: string, runId: string) => MutationId;
    stopBackgroundProcesses: (sessionId: string) => MutationId;
    stopBackgroundProcess: (sessionId: string, processSessionId: number) => MutationId;
    readBackgroundProcess: (
        sessionId: string,
        processSessionId: number,
        options?: { signal?: AbortSignal; waitMs?: number },
    ) => Promise<BackgroundProcessSnapshot | undefined>;
    resolveExternalToolCall: (
        sessionId: string,
        callId: string,
        resolution: ExternalToolCallResolution,
    ) => MutationId;
    cancelScheduledMessage: (sessionId: string, scheduledMessageId: string) => MutationId;
    recordActivity: (sessionId: string) => MutationId;
    connectTerminalPresence: (
        sessionId: string,
        options: { focused?: boolean; targetPid: number },
    ) => Promise<TerminalPresence>;
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

interface InboxSubscriber extends RigInboxSubscriptionOptions {
    closed: boolean;
}

interface InboxEntry {
    store: InboxStore;
    subscribers: Set<InboxSubscriber>;
}

interface ProviderUsageSubscriber extends RigProviderUsageSubscriptionOptions {
    closed: boolean;
}

interface ProviderUsageEntryState {
    controller: AbortController;
    inFlight: boolean;
    refreshIntervalMs: number;
    store: ProviderUsageStore;
    subscribers: Set<ProviderUsageSubscriber>;
    timer: ReturnType<typeof setTimeout> | undefined;
}

interface TimelineSubscriber extends RigTimelineSubscriptionOptions {
    closed: boolean;
}

interface TimelineEntry {
    bootstrapVersion: number;
    controller: AbortController;
    detachRoot: () => void;
    includeArchived: boolean;
    key: string;
    scope: TimelineScope;
    since?: number;
    started: boolean;
    store: TimelineStore;
    subscribers: Set<TimelineSubscriber>;
}

interface BufferedSessionEvent {
    cursor: string;
    event: SessionEvent;
}

interface SessionEntry {
    bootstrapVersion: number;
    bufferOverflowed: boolean;
    controller: AbortController;
    detachRoot: () => void;
    /**
     * Events held while a bootstrap is in flight.
     *
     * A snapshot is taken at one position and delivered asynchronously, so events
     * after that position can arrive before it lands. They are kept here and
     * replayed onto the snapshot rather than being applied to a session the
     * snapshot is about to replace.
     */
    pending?: BufferedSessionEvent[] | undefined;
    started: boolean;
    store: ChatStore;
    subscribers: Set<SessionSubscriber>;
    transcriptTurnLimit?: number;
}

interface GroupEntry {
    bootstrapVersion: number;
    controller: AbortController;
    detachRoot: () => void;
    started: boolean;
    store: GroupStore;
    subscribers: Set<GroupSubscriber>;
}

interface MutationRequest {
    body?: unknown;
    headers?: Readonly<Record<string, string>>;
    method: "DELETE" | "PATCH" | "POST" | "PUT";
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
    replacesTranscript?: boolean;
    retryOnConflict?: boolean;
    sessionId?: string;
    undo: () => void;
    versionSessionId?: string;
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

interface GitWatchEntity {
    projectId: string;
    workspaceId?: string;
}

/** Creates the one client a UI shares across its group and session views. */
export function connectRig(options: ConnectRigOptions): RigConnection {
    const request = options.fetch ?? globalThis.fetch;
    const wait = options.wait ?? defaultWait;
    const now = options.now ?? Date.now;
    const nextMutationId = orderedUuidV7(now, options.randomValues);
    // What the client creates, the client names. The identity is a cuid2, the
    // same kind the daemon would have minted, and it doubles as the mutation
    // identity so one create is one entity however its echo arrives.
    const nextEntityId = createCuid2(now, options.randomValues);
    const rootController = new AbortController();
    const sessionEntries = new Map<string, SessionEntry>();
    const queues = new Map<string, PendingMutation[]>();
    const activeWorkers = new Set<string>();
    const pendingOverlays: PendingMutation[] = [];
    const knownSessionCursors = new Map<string, string>();
    const knownGroupVersions = new Map<string, number>();
    const presenceClosers = new Set<() => void>();
    let groupsEntry: GroupEntry | undefined;
    let inboxEntry: InboxEntry | undefined;
    let providerUsageEntry: ProviderUsageEntryState | undefined;
    const timelineEntries = new Map<string, TimelineEntry>();
    let liveStreamStarted = false;
    let liveStreamOpen = false;
    let compatibility = CHECKING_SERVER_COMPATIBILITY;
    let gitWatchInFlight = false;
    let gitWatchPending = false;
    let gitWatchSignature = "";
    let gitWatchTimer: ReturnType<typeof setTimeout> | undefined;
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

    const publishInbox = (deltas: readonly InboxDelta[]): void => {
        if (closed || deltas.length === 0 || inboxEntry === undefined) return;
        for (const subscriber of [...inboxEntry.subscribers]) {
            if (subscriber.closed) continue;
            subscriber.onChange(inboxEntry.store.items(), inboxEntry.store.state());
            for (const delta of deltas) subscriber.onDelta?.(delta);
        }
    };

    const publishTimeline = (entry: TimelineEntry, deltas: readonly TimelineDelta[]): void => {
        if (closed || deltas.length === 0) return;
        for (const subscriber of [...entry.subscribers]) {
            if (subscriber.closed) continue;
            subscriber.onChange(entry.store.agents(), entry.store.state());
            for (const delta of deltas) subscriber.onDelta?.(delta);
        }
    };

    const setTimelineConnection = (connection: TimelineState["connection"]): void => {
        for (const entry of [...timelineEntries.values()]) {
            if (entry.started) publishTimeline(entry, entry.store.setConnection(connection));
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
        const versionSessionId = mutation.versionSessionId ?? mutation.sessionId;
        if (versionSessionId !== undefined) {
            const cursor =
                typeof value.session?.lastEventId === "string"
                    ? value.session.lastEventId
                    : typeof value.eventId === "string"
                      ? value.eventId
                      : undefined;
            if (cursor !== undefined) rememberSessionCursor(versionSessionId, cursor);
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
                            (mutation.replacesTranscript
                                ? sessionEntries
                                      .get(mutation.sessionId as string)
                                      ?.store.applySessionReplacement(session)
                                : sessionEntries
                                      .get(mutation.sessionId as string)
                                      ?.store.applySessionSnapshot(session)) ?? [],
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
        options.onMutationRejected?.(rejection);
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
                    if (
                        error instanceof MutationHttpError &&
                        error.status === 409 &&
                        mutation.retryOnConflict === true
                    ) {
                        recordAcceptedResponse(mutation, error.data);
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
            bootstrapVersion: 0,
            bufferOverflowed: false,
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

    /**
     * Loads a session by request-response and rebases it onto the live stream.
     *
     * The stream is opened first and this runs second, so an event that lands
     * while the bootstrap is in flight is still delivered and replayed on top of
     * what it describes.
     */
    const bootstrapSession = async (entry: SessionEntry): Promise<void> => {
        const sessionId = entry.store.session().sessionId;
        let version = ++entry.bootstrapVersion;
        // Collecting starts before the request, so an event that lands while it is
        // in flight is held rather than lost or applied out of order.
        entry.pending ??= [];
        let state: SessionStateResponse;
        while (true) {
            try {
                state = await fetchSessionState(
                    options.endpoint,
                    options.token,
                    sessionId,
                    entry.transcriptTurnLimit,
                    entry.store.newestMessageEventId(),
                    request,
                    entry.controller.signal,
                );
            } catch (error) {
                if (version !== entry.bootstrapVersion) return;
                entry.bufferOverflowed = false;
                entry.pending = undefined;
                throw error;
            }
            // A newer reload supersedes this answer. It shares the same pending
            // buffer, so events collected by this request remain available to the
            // request that will actually land.
            if (version !== entry.bootstrapVersion) return;
            if (!entry.bufferOverflowed) break;
            // The bounded buffer could not prove continuity. Take a newer
            // snapshot while continuing to collect, rather than applying a
            // response that might have an event missing after its cursor.
            entry.bufferOverflowed = false;
            entry.pending = [];
            version = ++entry.bootstrapVersion;
        }
        // Only what the snapshot does not already contain. The cursor is the
        // global-stream position it was taken at. Session event ids come from a
        // different UUID scope and cannot be compared with it.
        const replay = (entry.pending ?? []).filter((item) => item.cursor > state.cursor);
        entry.pending = undefined;
        const newest = replay.at(-1)?.event.id ?? state.lastEventId;
        if (newest !== undefined) rememberSessionCursor(sessionId, newest);
        reconcile([sessionKey(sessionId)], undefined, [sessionId], true, () => ({
            sessionDeltas: new Map([
                [
                    sessionId,
                    [
                        ...entry.store.setConnection("live"),
                        ...entry.store.applyHello(state),
                        ...replay.flatMap(({ event }) => [...entry.store.apply(event)]),
                    ],
                ],
            ]),
        }));
        queueGitWatchSync();
    };

    const startSessionEntry = (entry: SessionEntry): void => {
        if (entry.started) return;
        entry.started = true;
        ensureLiveStream();
        // Opening the stream reports a position, and that is what triggers the
        // load. A view attaching to a stream that is already open has missed that
        // signal, so it loads now instead.
        if (!liveStreamOpen) return;
        void bootstrapSession(entry).catch((error: unknown) => {
            if (closed || entry.controller.signal.aborted) return;
            publishSession(entry, entry.store.setConnection("closed"));
            for (const subscriber of [...entry.subscribers]) subscriber.onError?.(error);
        });
    };

    const createGroupEntry = (): GroupEntry => {
        if (groupsEntry !== undefined) return groupsEntry;
        const linked = linkedController(rootController.signal);
        const entry: GroupEntry = {
            bootstrapVersion: 0,
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

    const loadCatalog = async (entry: GroupEntry): Promise<void> => {
        const version = ++entry.bootstrapVersion;
        let hello: GlobalStreamHello;
        try {
            hello = await fetchCatalog(
                options.endpoint,
                options.token,
                request,
                entry.controller.signal,
            );
        } catch (error) {
            if (version !== entry.bootstrapVersion) return;
            throw error;
        }
        if (version !== entry.bootstrapVersion) return;
        const catalogCompatibility = serverCompatibility(hello.protocolVersion);
        if (catalogCompatibility.status !== "compatible") {
            throw new Error(describeServerCompatibility(catalogCompatibility));
        }
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
        if (inboxEntry !== undefined) {
            publishInbox([
                ...inboxEntry.store.setConnection("live"),
                ...inboxEntry.store.applyHello(hello),
            ]);
        }
        queueGitWatchSync();
    };

    const startGroupEntry = (entry: GroupEntry): void => {
        if (entry.started) return;
        entry.started = true;
        ensureLiveStream();
        if (!liveStreamOpen) return;
        void loadCatalog(entry).catch((error: unknown) => {
            if (closed || entry.controller.signal.aborted) return;
            publishGroups(entry, entry.store.setConnection("closed"));
            for (const subscriber of [...entry.subscribers]) subscriber.onError?.(error);
            if (inboxEntry !== undefined) {
                publishInbox(inboxEntry.store.setConnection("closed"));
                for (const subscriber of [...inboxEntry.subscribers]) {
                    subscriber.onError?.(error);
                }
            }
        });
    };

    const createTimelineEntry = (subscription: RigTimelineSubscriptionOptions): TimelineEntry => {
        const key = timelineKey(subscription);
        const existing = timelineEntries.get(key);
        if (existing !== undefined) return existing;
        const linked = linkedController(rootController.signal);
        const entry: TimelineEntry = {
            bootstrapVersion: 0,
            controller: linked.controller,
            detachRoot: linked.detach,
            includeArchived: subscription.includeArchived ?? false,
            key,
            scope: subscription.scope,
            started: false,
            store: new TimelineStore(subscription.scope),
            subscribers: new Set(),
            ...(subscription.since === undefined ? {} : { since: subscription.since }),
        };
        timelineEntries.set(key, entry);
        return entry;
    };

    const loadTimeline = async (entry: TimelineEntry): Promise<void> => {
        const version = ++entry.bootstrapVersion;
        let snapshot: GetTimelineResponse;
        try {
            snapshot = await fetchTimeline(
                options.endpoint,
                options.token,
                request,
                entry,
                entry.controller.signal,
            );
        } catch (error) {
            if (version !== entry.bootstrapVersion) return;
            throw error;
        }
        if (version !== entry.bootstrapVersion) return;
        publishTimeline(entry, [
            ...entry.store.setConnection("live"),
            ...entry.store.applySnapshot(snapshot),
        ]);
    };

    const startTimelineEntry = (entry: TimelineEntry): void => {
        if (entry.started) return;
        entry.started = true;
        ensureLiveStream();
        if (!liveStreamOpen) return;
        void loadTimeline(entry).catch((error: unknown) => {
            if (closed || entry.controller.signal.aborted) return;
            publishTimeline(entry, entry.store.setConnection("closed"));
            for (const subscriber of [...entry.subscribers]) subscriber.onError?.(error);
        });
    };

    /**
     * Opens the one subscription this connection has, if it is not open already.
     *
     * Groups and chats are both views over this single stream: a chat filters it
     * down to the session it is showing rather than opening a stream of its own.
     */
    const ensureLiveStream = (): void => {
        if (liveStreamStarted) return;
        liveStreamStarted = true;
        void streamLiveEvents({
            endpoint: options.endpoint,
            fetch: request,
            signal: rootController.signal,
            token: options.token,
            ...(options.wait === undefined ? {} : { wait }),
            onOpen: (hello) => {
                const nextCompatibility = serverCompatibility(hello.protocolVersion);
                if (
                    nextCompatibility.status !== compatibility.status ||
                    ("serverProtocolVersion" in nextCompatibility &&
                        (!("serverProtocolVersion" in compatibility) ||
                            nextCompatibility.serverProtocolVersion !==
                                compatibility.serverProtocolVersion))
                ) {
                    compatibility = nextCompatibility;
                    options.onCompatibilityChange?.(compatibility);
                }
                if (nextCompatibility.status !== "compatible") return false;
                liveStreamOpen = true;
                // A clean resume replayed every missed event, so what this client
                // holds is already current. A gap is what leaves it uncertain, and
                // a first open is the case where it holds nothing at all.
                //
                // Nothing needs reloading here, but the views are still showing
                // "reconnecting", so they are told the stream is live. On the
                // reload path this is deliberately left to the load itself: a view
                // must not report live while it is still empty.
                if (hello.resumed && !hello.gap) {
                    if (groupsEntry !== undefined) {
                        publishGroups(groupsEntry, groupsEntry.store.setConnection("live"));
                    }
                    if (inboxEntry !== undefined) {
                        publishInbox(inboxEntry.store.setConnection("live"));
                    }
                    setTimelineConnection("live");
                    for (const entry of [...sessionEntries.values()]) {
                        if (entry.started) publishSession(entry, entry.store.setConnection("live"));
                    }
                    return true;
                }
                gitWatchSignature = "";
                if (gitWatchTimer !== undefined) clearTimeout(gitWatchTimer);
                gitWatchTimer = undefined;
                const groups = groupsEntry;
                if (groups !== undefined && groups.started) {
                    void loadCatalog(groups).catch((error: unknown) => {
                        if (closed || groups.controller.signal.aborted) return;
                        for (const subscriber of [...groups.subscribers]) {
                            subscriber.onError?.(error);
                        }
                    });
                }
                for (const entry of [...sessionEntries.values()]) {
                    if (!entry.started) continue;
                    void bootstrapSession(entry).catch((error: unknown) => {
                        if (closed || entry.controller.signal.aborted) return;
                        for (const subscriber of [...entry.subscribers]) {
                            subscriber.onError?.(error);
                        }
                    });
                }
                // A gap means this chart may have missed the events that closed
                // a span, so it is rebuilt from the daemon rather than left to
                // drift. A first open loads it for the first time.
                for (const entry of [...timelineEntries.values()]) {
                    if (!entry.started) continue;
                    void loadTimeline(entry).catch((error: unknown) => {
                        if (closed || entry.controller.signal.aborted) return;
                        for (const subscriber of [...entry.subscribers]) {
                            subscriber.onError?.(error);
                        }
                    });
                }
                return true;
            },
            onEvent: (event, cursor) => {
                rememberGlobalIdentity(event);
                if (
                    event.type === "project_git_changed" ||
                    event.type === "workspace_git_changed"
                ) {
                    applyGitSnapshot(event);
                    return;
                }
                if ("sessionId" in event && typeof event.sessionId === "string") {
                    // Held only while that session is bootstrapping; the snapshot
                    // replays these itself once it lands.
                    const entry = sessionEntries.get(event.sessionId);
                    if (entry?.pending !== undefined) {
                        if (entry.pending.length === MAXIMUM_BUFFERED_SESSION_EVENTS) {
                            entry.pending.shift();
                            entry.bufferOverflowed = true;
                        }
                        entry.pending.push({ cursor, event: event as SessionEvent });
                    }
                }
                const mutationId = mutationIdOf(event);
                const mutationKey = pendingOverlays.find(
                    (mutation) => mutation.id === mutationId,
                )?.entityKey;
                const key = globalEventKey(event);
                const sessionId =
                    "sessionId" in event && typeof event.sessionId === "string"
                        ? event.sessionId
                        : undefined;
                const session = sessionId === undefined ? undefined : sessionEntries.get(sessionId);
                const unreadBefore =
                    sessionId === undefined
                        ? undefined
                        : groupsEntry?.store.sessionSummary(sessionId)?.unread;
                reconcile(
                    mutationKey === undefined ? [key] : [key, mutationKey],
                    mutationId,
                    sessionId === undefined ? [] : [sessionId],
                    true,
                    () => ({
                        ...(groupsEntry === undefined
                            ? {}
                            : { groupDeltas: groupsEntry.store.apply(event) }),
                        ...(session === undefined ||
                        sessionId === undefined ||
                        session.pending !== undefined
                            ? {}
                            : {
                                  sessionDeltas: new Map([
                                      [sessionId, session.store.apply(event as SessionEvent)],
                                  ]),
                              }),
                    }),
                );
                if (inboxEntry !== undefined) publishInbox(inboxEntry.store.apply(event));
                for (const entry of [...timelineEntries.values()]) {
                    if (entry.started) publishTimeline(entry, entry.store.apply(event));
                }
                if (sessionId !== undefined) reportFinished(sessionId, unreadBefore);
                if (
                    event.type === "project_created" ||
                    event.type === "project_updated" ||
                    event.type === "workspace_created" ||
                    event.type === "workspace_updated"
                ) {
                    queueGitWatchSync();
                }
            },
            onDisconnected: () => {
                liveStreamOpen = false;
                if (groupsEntry !== undefined) {
                    publishGroups(groupsEntry, groupsEntry.store.setConnection("reconnecting"));
                }
                if (inboxEntry !== undefined) {
                    publishInbox(inboxEntry.store.setConnection("reconnecting"));
                }
                setTimelineConnection("reconnecting");
                for (const entry of [...sessionEntries.values()]) {
                    if (entry.started) {
                        publishSession(entry, entry.store.setConnection("reconnecting"));
                    }
                }
            },
        })
            .catch((error: unknown) => {
                if (closed || rootController.signal.aborted) return;
                if (groupsEntry !== undefined) {
                    publishGroups(groupsEntry, groupsEntry.store.setConnection("closed"));
                    for (const subscriber of [...groupsEntry.subscribers]) {
                        subscriber.onError?.(error);
                    }
                }
                if (inboxEntry !== undefined) {
                    publishInbox(inboxEntry.store.setConnection("closed"));
                    for (const subscriber of [...inboxEntry.subscribers]) {
                        subscriber.onError?.(error);
                    }
                }
                for (const entry of [...sessionEntries.values()]) {
                    publishSession(entry, entry.store.setConnection("closed"));
                    for (const subscriber of [...entry.subscribers]) subscriber.onError?.(error);
                }
                for (const entry of [...timelineEntries.values()]) {
                    publishTimeline(entry, entry.store.setConnection("closed"));
                    for (const subscriber of [...entry.subscribers]) subscriber.onError?.(error);
                }
            })
            .finally(() => {
                if (closed || rootController.signal.aborted) return;
                if (groupsEntry !== undefined) {
                    publishGroups(groupsEntry, groupsEntry.store.setConnection("closed"));
                }
                if (inboxEntry !== undefined) {
                    publishInbox(inboxEntry.store.setConnection("closed"));
                }
                for (const entry of [...sessionEntries.values()]) {
                    publishSession(entry, entry.store.setConnection("closed"));
                }
                setTimelineConnection("closed");
            });
    };

    /**
     * Announces a chat that has just started waiting for the person.
     *
     * Only the transition is reported. A chat already waiting stays quiet, so a
     * burst of events from one stopped run makes one sound, and a reconnect that
     * reloads the same waiting chat makes none.
     */
    const reportFinished = (sessionId: string, before: SessionUnreadState | undefined): void => {
        const notify = options.onSessionFinished;
        if (notify === undefined) return;
        const summary = groupsEntry?.store.sessionSummary(sessionId);
        const unread = summary?.unread;
        if (summary === undefined || unread === undefined) return;
        if (before !== undefined && before.reason === unread.reason) return;
        notify({
            projectId: summary.projectId,
            reason: unread.reason,
            sessionId,
            since: unread.since,
            ...(summary.workspaceId === undefined ? {} : { workspaceId: summary.workspaceId }),
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

    const applyGitSnapshot = (event: GlobalEvent): void => {
        if (event.type !== "project_git_changed" && event.type !== "workspace_git_changed") return;
        const scope = event as {
            data: { git: GitChangeSnapshot };
            projectId: string;
            workspaceId?: string;
        };
        const affected = [...sessionEntries.entries()].filter(([, entry]) => {
            const session = entry.store.session();
            return (
                session.projectId === scope.projectId && session.workspaceId === scope.workspaceId
            );
        });
        reconcile(
            [globalEventKey(event)],
            undefined,
            affected.map(([sessionId]) => sessionId),
            groupsEntry !== undefined,
            () => ({
                ...(groupsEntry === undefined
                    ? {}
                    : { groupDeltas: groupsEntry.store.apply(event) }),
                ...(affected.length === 0
                    ? {}
                    : {
                          sessionDeltas: new Map(
                              affected.map(([sessionId, entry]) => [
                                  sessionId,
                                  entry.store.applyGitSnapshot(scope.data.git),
                              ]),
                          ),
                      }),
            }),
        );
    };

    const gitWatchEntities = (): readonly GitWatchEntity[] => {
        const entities = new Map<string, GitWatchEntity>();
        const add = (entity: GitWatchEntity): void => {
            const key =
                entity.workspaceId === undefined
                    ? `project:${entity.projectId}`
                    : `workspace:${entity.workspaceId}`;
            entities.set(key, entity);
        };
        for (const project of groupsEntry?.store.projects() ?? []) {
            add({ projectId: project.id });
            for (const workspace of project.workspaces) {
                add({ projectId: project.id, workspaceId: workspace.id });
            }
        }
        for (const entry of sessionEntries.values()) {
            const session = entry.store.session();
            if (session.projectId.length === 0) continue;
            add({
                projectId: session.projectId,
                ...(session.workspaceId === undefined ? {} : { workspaceId: session.workspaceId }),
            });
        }
        return [...entities]
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([, value]) => value);
    };

    const scheduleGitWatchSync = (delay: number): void => {
        if (gitWatchTimer !== undefined) clearTimeout(gitWatchTimer);
        gitWatchTimer = setTimeout(() => {
            gitWatchTimer = undefined;
            queueGitWatchSync(true);
        }, delay);
    };

    const queueGitWatchSync = (force = false): void => {
        if (closed) return;
        const entities = gitWatchEntities();
        const signature = JSON.stringify(entities);
        if (!force && signature === gitWatchSignature) return;
        if (gitWatchInFlight) {
            gitWatchPending = true;
            return;
        }
        if (entities.length === 0) {
            gitWatchSignature = "";
            if (gitWatchTimer !== undefined) clearTimeout(gitWatchTimer);
            gitWatchTimer = undefined;
            return;
        }
        gitWatchInFlight = true;
        gitWatchSignature = signature;
        void fetchGitWatch(
            options.endpoint,
            options.token,
            entities,
            request,
            rootController.signal,
        )
            .then((snapshots) => {
                if (closed) return;
                for (const snapshot of snapshots) applyGitSnapshot(snapshot);
                scheduleGitWatchSync(GIT_WATCH_RENEWAL_MS);
            })
            .catch(() => {
                if (closed || rootController.signal.aborted) return;
                if (gitWatchSignature === signature) gitWatchSignature = "";
                scheduleGitWatchSync(GIT_WATCH_RETRY_MS);
            })
            .finally(() => {
                gitWatchInFlight = false;
                if (!gitWatchPending || closed) return;
                gitWatchPending = false;
                queueGitWatchSync();
            });
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
        for (const [key, entry] of [...timelineEntries]) {
            if (entry.subscribers.size > 0) continue;
            entry.controller.abort();
            entry.detachRoot();
            timelineEntries.delete(key);
        }
        if (
            groupsEntry !== undefined &&
            groupsEntry.subscribers.size === 0 &&
            // Finish notifications are answered from the catalog, which is where
            // the chat's project and whether it is tracked at all are known, so
            // asking for them keeps it loaded with no view open.
            options.onSessionFinished === undefined &&
            inboxEntry === undefined &&
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

    const connectInbox = (subscription: RigInboxSubscriptionOptions): RigInboxConnection => {
        if (closed) throw new Error("This Rig connection is closed.");
        inboxEntry ??= { store: new InboxStore(), subscribers: new Set() };
        const subscriber: InboxSubscriber = { ...subscription, closed: false };
        inboxEntry.subscribers.add(subscriber);
        subscriber.onChange(inboxEntry.store.items(), inboxEntry.store.state());
        startGroupEntry(createGroupEntry());
        return {
            items: () => inboxEntry?.store.items() ?? [],
            state: () => inboxEntry?.store.state() ?? { connection: "closed" },
            close: () => {
                if (subscriber.closed) return;
                subscriber.closed = true;
                inboxEntry?.subscribers.delete(subscriber);
                if (inboxEntry?.subscribers.size === 0) inboxEntry = undefined;
                releaseUnusedEntries();
            },
        };
    };

    const publishProviderUsage = (deltas: readonly ProviderUsageDelta[]): void => {
        if (closed || providerUsageEntry === undefined || deltas.length === 0) return;
        const entry = providerUsageEntry;
        for (const subscriber of [...entry.subscribers]) {
            if (subscriber.closed) continue;
            subscriber.onChange(entry.store.providers(), entry.store.state());
            if (subscriber.onDelta === undefined) continue;
            for (const delta of deltas) subscriber.onDelta(delta);
        }
    };

    const readProviderUsage = async (): Promise<void> => {
        const entry = providerUsageEntry;
        // One read at a time: a manual refresh landing on top of the interval
        // must not produce two answers racing into the same store.
        if (entry === undefined || entry.inFlight || closed) return;
        entry.inFlight = true;
        try {
            const { data } = await requestJson("/provider-usage", { signal: entry.controller.signal });
            if (providerUsageEntry !== entry) return;
            const providers = (data as ListProviderUsageResponse | null)?.providers ?? [];
            publishProviderUsage(entry.store.applyProviders(providers, now()));
        } catch (error) {
            if (providerUsageEntry !== entry || entry.controller.signal.aborted) return;
            publishProviderUsage(entry.store.applyError(humanProviderUsageError(error)));
            for (const subscriber of [...entry.subscribers]) subscriber.onError?.(error);
        } finally {
            entry.inFlight = false;
        }
    };

    const scheduleProviderUsage = (entry: ProviderUsageEntryState): void => {
        if (entry.timer !== undefined) clearTimeout(entry.timer);
        entry.timer = setTimeout(() => {
            if (providerUsageEntry !== entry) return;
            void readProviderUsage().finally(() => {
                // Chained from the end of a read rather than run on a fixed
                // interval, so a slow daemon cannot queue reads behind itself.
                if (providerUsageEntry === entry) scheduleProviderUsage(entry);
            });
        }, entry.refreshIntervalMs);
    };

    const connectProviderUsage = (
        subscription: RigProviderUsageSubscriptionOptions,
    ): RigProviderUsageConnection => {
        if (closed) throw new Error("This Rig connection is closed.");
        const first = providerUsageEntry === undefined;
        providerUsageEntry ??= {
            controller: new AbortController(),
            inFlight: false,
            refreshIntervalMs:
                subscription.refreshIntervalMs ?? DEFAULT_PROVIDER_USAGE_REFRESH_MS,
            store: new ProviderUsageStore(),
            subscribers: new Set(),
            timer: undefined,
        };
        const entry = providerUsageEntry;
        const subscriber: ProviderUsageSubscriber = { ...subscription, closed: false };
        entry.subscribers.add(subscriber);
        // The state is handed over before anything is read, so a view renders
        // its loading state from the same value it will later render usage from.
        subscriber.onChange(entry.store.providers(), entry.store.state());
        if (first) {
            void readProviderUsage().finally(() => {
                if (providerUsageEntry === entry) scheduleProviderUsage(entry);
            });
        }
        return {
            providers: () => entry.store.providers(),
            state: () => entry.store.state(),
            refresh: async () => {
                if (providerUsageEntry !== entry) return;
                await readProviderUsage();
                if (providerUsageEntry === entry) scheduleProviderUsage(entry);
            },
            close: () => {
                if (subscriber.closed) return;
                subscriber.closed = true;
                entry.subscribers.delete(subscriber);
                // The last view leaving stops the polling and forgets the
                // readings, so a mounted view never shows a stale first frame.
                if (entry.subscribers.size === 0) {
                    if (entry.timer !== undefined) clearTimeout(entry.timer);
                    entry.controller.abort();
                    if (providerUsageEntry === entry) providerUsageEntry = undefined;
                }
            },
        };
    };

    const connectTimeline = (
        subscription: RigTimelineSubscriptionOptions,
    ): RigTimelineConnection => {
        if (closed) throw new Error("This Rig connection is closed.");
        const entry = createTimelineEntry(subscription);
        const subscriber: TimelineSubscriber = { ...subscription, closed: false };
        entry.subscribers.add(subscriber);
        subscriber.onChange(entry.store.agents(), entry.store.state());
        startTimelineEntry(entry);
        return {
            agents: () => entry.store.agents(),
            state: () => entry.store.state(),
            close: () => {
                if (subscriber.closed) return;
                subscriber.closed = true;
                entry.subscribers.delete(subscriber);
                releaseUnusedEntries();
            },
        };
    };

    const requestJson = async (
        path: string,
        init: RequestInit = {},
    ): Promise<{ data: unknown; status: number }> => {
        if (closed) throw new Error("This Rig connection is closed.");
        const headers = new Headers(init.headers);
        headers.set("accept", "application/json");
        headers.set("authorization", `Bearer ${options.token}`);
        const response = await request(endpointUrl(options.endpoint, path), {
            ...init,
            headers,
        });
        const data = await readResponseBody(response);
        if (!response.ok && response.status !== 404) {
            throw new MutationHttpError(
                response.status,
                humanMutationError(data, response.status),
                retryAfterMilliseconds(response.headers.get("retry-after"), now()),
                data,
            );
        }
        return { data, status: response.status };
    };

    const enqueueSessionUpdate = (
        action: MutationAction,
        sessionId: string,
        path: string,
        method: MutationRequest["method"],
        body: object,
        patch: Partial<SessionState>,
        clear: readonly (keyof SessionState)[] = [],
        replacesTranscript = false,
    ): MutationId => {
        const id = nextMutationId();
        const key = sessionKey(sessionId);
        const mutation: PendingMutation = {
            acknowledged: false,
            action,
            entityKey: key,
            id,
            sessionId,
            undo: () => undefined,
            applyOptimistic: (publish) => {
                const entry = sessionEntries.get(sessionId);
                if (entry === undefined) return () => undefined;
                const changed = entry.store.applyOptimisticSession(patch, clear);
                if (publish) publishSession(entry, changed.deltas);
                return changed.undo;
            },
            prepare: () => {
                const expectedEventId = currentSessionCursor(sessionId);
                return {
                    body: { ...body, mutationId: id },
                    headers: {
                        ...ifMatchHeader(expectedEventId),
                        "x-rig-mutation-id": id,
                    },
                    method,
                    url: endpointUrl(
                        options.endpoint,
                        `sessions/${encodeURIComponent(sessionId)}${path.length === 0 ? "" : `/${path}`}`,
                    ),
                };
            },
            matchesAuthoritative: (data) => {
                const session = responseEntity(data, "session");
                return (
                    session !== undefined &&
                    Object.entries(patch).every(([name, value]) => session[name] === value) &&
                    clear.every((name) => session[name] === undefined)
                );
            },
            ...(replacesTranscript ? { replacesTranscript: true } : {}),
            retryOnConflict: true,
            versionSessionId: sessionId,
        };
        return enqueue(mutation);
    };

    const createSession = (input: CreateSessionInput): MutationId => {
        const id = nextEntityId();
        return enqueue({
            acknowledged: false,
            action: "create_session",
            applyOptimistic: () => () => undefined,
            entityKey: sessionKey(id),
            id,
            prepare: () => ({
                body: { ...input, id },
                headers: { "x-rig-mutation-id": id },
                method: "POST",
                url: endpointUrl(options.endpoint, "sessions"),
            }),
            sessionId: id,
            undo: () => undefined,
        });
    };

    const createWorkspace = (input: CreateWorkspaceInput): MutationId => {
        const id = nextEntityId();
        const key = workspaceKey(input.projectId, id);
        const createdAt = now();
        const optimistic: ProjectWorkspace = {
            ...(input.baseRef === undefined ? {} : { baseRef: input.baseRef }),
            createdAt,
            id,
            kind: "git_worktree",
            name: input.name,
            orderKey: "",
            path: "",
            presence: "missing",
            projectId: input.projectId,
            status: "initializing",
            updatedAt: createdAt,
            version: 0,
        };
        return enqueue({
            acknowledged: false,
            action: "create_workspace",
            applyOptimistic: (publish) => {
                if (groupsEntry === undefined) return () => undefined;
                const changed = groupsEntry.store.applyOptimisticWorkspaceCreate(optimistic);
                if (publish) publishGroups(groupsEntry, changed.deltas);
                return changed.undo;
            },
            entityKey: key,
            id,
            matchesAuthoritative: (data) => responseEntity(data, "workspace")?.id === id,
            prepare: () => ({
                body: {
                    ...(input.baseRef === undefined ? {} : { baseRef: input.baseRef }),
                    id,
                    name: input.name,
                },
                headers: { "x-rig-mutation-id": id },
                method: "POST",
                url: endpointUrl(
                    options.endpoint,
                    `projects/${encodeURIComponent(input.projectId)}/workspaces`,
                ),
            }),
            undo: () => undefined,
        });
    };

    const archiveWorkspace = (projectId: string, workspaceId: string): MutationId => {
        const id = nextMutationId();
        const target: GroupTarget = { kind: "workspace", projectId, workspaceId };
        let expectedVersion: number | undefined;
        return enqueue({
            acknowledged: false,
            action: "archive_workspace",
            applyOptimistic: (publish) => {
                if (groupsEntry === undefined) return () => undefined;
                const changed = groupsEntry.store.applyOptimisticWorkspaceArchived(
                    projectId,
                    workspaceId,
                );
                if (publish) publishGroups(groupsEntry, changed.deltas);
                return changed.undo;
            },
            entityKey: groupKey(target),
            id,
            matchesAuthoritative: (data) => {
                const workspace = responseEntity(data, "workspace");
                return (
                    workspace === undefined ||
                    workspace.status === "archiving" ||
                    workspace.status === "archived"
                );
            },
            prepare: () => {
                expectedVersion ??= groupVersion(target);
                return {
                    headers: {
                        ...ifMatchHeader(expectedVersion),
                        "x-rig-mutation-id": id,
                    },
                    method: "POST",
                    url: endpointUrl(
                        options.endpoint,
                        `projects/${encodeURIComponent(projectId)}/workspaces/${encodeURIComponent(workspaceId)}/archive`,
                    ),
                };
            },
            retryOnConflict: true,
            undo: () => undefined,
        });
    };

    const forkSession = (sourceSessionId: string): MutationId => {
        const id = nextMutationId();
        return enqueue({
            acknowledged: false,
            action: "fork_session",
            applyOptimistic: () => () => undefined,
            entityKey: sessionKey(sourceSessionId),
            id,
            prepare: () => {
                const expectedEventId = currentSessionCursor(sourceSessionId);
                return {
                    headers: {
                        ...ifMatchHeader(expectedEventId),
                        "x-rig-mutation-id": id,
                    },
                    method: "POST",
                    url: endpointUrl(
                        options.endpoint,
                        `sessions/${encodeURIComponent(sourceSessionId)}/fork`,
                    ),
                };
            },
            retryOnConflict: true,
            sessionId: id,
            undo: () => undefined,
            versionSessionId: sourceSessionId,
        });
    };

    const sendMessage = (sessionId: string, message: string | SendMessageInput): MutationId => {
        const input = typeof message === "string" ? { text: message } : message;
        const id = nextMutationId();
        const key = sessionKey(sessionId);
        const expectedRunId = sessionEntries.get(sessionId)?.store.session().activeTurn?.runId;
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
                        status: expectedRunId === undefined ? "queued" : "running",
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
                        ...(expectedRunId === undefined ? {} : { expectedRunId }),
                        mutationId: id,
                        text: input.text,
                    },
                    headers: ifMatchHeader(expectedEventId),
                    method: "POST",
                    url: endpointUrl(
                        options.endpoint,
                        `sessions/${encodeURIComponent(sessionId)}/${expectedRunId === undefined ? "messages" : "steer"}`,
                    ),
                };
            },
        };
        return enqueue(mutation);
    };

    const stopRun = (sessionId: string): MutationId => {
        const id = nextMutationId();
        const key = sessionKey(sessionId);
        const expectedRunId = sessionEntries.get(sessionId)?.store.session().activeTurn?.runId;
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
                                : { runId: current.activeTurn.runId }),
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

    const setEffort = (sessionId: string, effort?: string): MutationId =>
        enqueueSessionUpdate(
            "set_effort",
            sessionId,
            "effort",
            "PATCH",
            effort === undefined ? {} : { effort },
            effort === undefined ? {} : { effort },
            effort === undefined ? ["effort"] : [],
        );

    const setServiceTier = (sessionId: string, serviceTier?: string): MutationId =>
        enqueueSessionUpdate(
            "set_service_tier",
            sessionId,
            "service-tier",
            "PATCH",
            serviceTier === undefined ? {} : { serviceTier },
            serviceTier === undefined ? {} : { serviceTier },
            serviceTier === undefined ? ["serviceTier"] : [],
        );

    const setPermissionMode = (sessionId: string, permissionMode: string): MutationId =>
        enqueueSessionUpdate(
            "set_permission_mode",
            sessionId,
            "permissions",
            "PATCH",
            { permissionMode },
            { permissionMode },
        );

    const setDraft = (sessionId: string, input: string | DraftUpdate): MutationId => {
        const update: DraftUpdate =
            typeof input === "string" ? { draft: input.length === 0 ? null : input } : input;
        const updatedAt = update.updatedAt ?? now();
        return enqueueSessionUpdate(
            "set_draft",
            sessionId,
            "draft",
            "PUT",
            {
                draft: update.draft,
                ...(update.origin === undefined ? {} : { origin: update.origin }),
                updatedAt,
            },
            update.draft === null
                ? { draftUpdatedAt: updatedAt }
                : { draft: update.draft, draftUpdatedAt: updatedAt },
            update.draft === null ? ["draft"] : [],
        );
    };

    const setAppendSystemPrompt = (sessionId: string, prompt: string | null): MutationId =>
        enqueueSessionUpdate(
            "set_append_system_prompt",
            sessionId,
            "",
            "PATCH",
            { appendSystemPrompt: prompt },
            prompt === null ? {} : { appendSystemPrompt: prompt },
            prompt === null ? ["appendSystemPrompt"] : [],
        );

    const answerUserInput = (
        sessionId: string,
        requestId: string,
        response: UserInputAnswers,
    ): MutationId => {
        const current = sessionEntries.get(sessionId)?.store.session().pendingUserInputs ?? [];
        return enqueueSessionUpdate(
            "answer_user_input",
            sessionId,
            `user-input/${encodeURIComponent(requestId)}`,
            "POST",
            response,
            {
                pendingUserInputs: current.filter((request) => request.requestId !== requestId),
            },
        );
    };

    const setGoal = (sessionId: string, objective: string): MutationId => {
        const timestamp = now();
        return enqueueSessionUpdate(
            "set_goal",
            sessionId,
            "goal",
            "POST",
            { objective },
            {
                goal: {
                    createdAt: timestamp,
                    objective,
                    status: "active",
                    updatedAt: timestamp,
                },
            },
        );
    };

    const setGoalStatus = (sessionId: string, status: GoalStatus): MutationId => {
        const goal = sessionEntries.get(sessionId)?.store.session().goal;
        return enqueueSessionUpdate(
            "set_goal_status",
            sessionId,
            "goal",
            "PATCH",
            { status },
            goal === undefined ? {} : { goal: { ...goal, status, updatedAt: now() } },
        );
    };

    const clearGoal = (sessionId: string): MutationId =>
        enqueueSessionUpdate("clear_goal", sessionId, "goal", "DELETE", {}, {}, ["goal"]);

    const attachSecret = (
        sessionId: string,
        secretId: string,
        scope: SecretAttachmentScope = "session",
    ): MutationId => {
        const session = sessionEntries.get(sessionId)?.store.session();
        const scoped =
            scope === "project"
                ? uniqueAppend(session?.projectSecretIds ?? [], secretId)
                : uniqueAppend(session?.sessionSecretIds ?? [], secretId);
        return enqueueSessionUpdate(
            "attach_secret",
            sessionId,
            "secrets",
            "POST",
            { scope, secretId },
            {
                ...(scope === "project"
                    ? { projectSecretIds: scoped }
                    : { sessionSecretIds: scoped }),
                secretIds: uniqueAppend(session?.secretIds ?? [], secretId),
            },
        );
    };

    const detachSecret = (
        sessionId: string,
        secretId: string,
        scope: SecretAttachmentScope = "session",
    ): MutationId => {
        const session = sessionEntries.get(sessionId)?.store.session();
        const remainingProject =
            scope === "project"
                ? (session?.projectSecretIds ?? []).filter((id) => id !== secretId)
                : (session?.projectSecretIds ?? []);
        const remainingSession =
            scope === "session"
                ? (session?.sessionSecretIds ?? []).filter((id) => id !== secretId)
                : (session?.sessionSecretIds ?? []);
        return enqueueSessionUpdate(
            "detach_secret",
            sessionId,
            `secrets/${encodeURIComponent(secretId)}?scope=${scope}`,
            "DELETE",
            {},
            {
                projectSecretIds: remainingProject,
                secretIds: uniqueAppend(remainingProject, ...remainingSession),
                sessionSecretIds: remainingSession,
            },
        );
    };

    const compactSession = (sessionId: string): MutationId =>
        enqueueSessionUpdate(
            "compact_session",
            sessionId,
            "compact",
            "POST",
            {},
            {
                activity: {
                    kind: "compacting",
                    label: "Compacting",
                    since: now(),
                },
            },
            [],
            true,
        );

    const resetSession = (sessionId: string): MutationId =>
        enqueueSessionUpdate(
            "reset_session",
            sessionId,
            "reset",
            "POST",
            {},
            {
                activity: { kind: "stopped", label: "Resetting", since: now() },
            },
            [],
            true,
        );

    const rewindSession = (sessionId: string, messageId: string): MutationId =>
        enqueueSessionUpdate(
            "rewind_session",
            sessionId,
            "rewind",
            "POST",
            { messageId },
            {
                activity: { kind: "stopped", label: "Rewinding", since: now() },
            },
            [],
            true,
        );

    const runShellCommand = (sessionId: string, input: ShellCommandInput): MutationId => {
        const commands = sessionEntries.get(sessionId)?.store.session().shellCommands ?? [];
        return enqueueSessionUpdate("run_shell_command", sessionId, "shell", "POST", input, {
            shellCommands: [
                ...commands.filter((command) => command.commandId !== input.commandId),
                { ...input, status: "running" },
            ],
        });
    };

    const stopWorkflow = (sessionId: string, runId: string): MutationId => {
        const workflows = sessionEntries.get(sessionId)?.store.session().workflows ?? [];
        return enqueueSessionUpdate(
            "stop_workflow",
            sessionId,
            `workflows/${encodeURIComponent(runId)}/stop`,
            "POST",
            {},
            {
                workflows: workflows.map((workflow) =>
                    workflow.runId === runId
                        ? { ...workflow, finishedAt: now(), status: "stopped" }
                        : workflow,
                ),
            },
        );
    };

    const stopBackgroundProcesses = (sessionId: string): MutationId =>
        enqueueSessionUpdate(
            "stop_background_processes",
            sessionId,
            "background-processes/stop",
            "POST",
            {},
            { backgroundProcesses: [] },
        );

    const stopBackgroundProcess = (sessionId: string, processSessionId: number): MutationId => {
        const processes = sessionEntries.get(sessionId)?.store.session().backgroundProcesses ?? [];
        return enqueueSessionUpdate(
            "stop_background_process",
            sessionId,
            `background-processes/${encodeURIComponent(String(processSessionId))}`,
            "DELETE",
            {},
            {
                backgroundProcesses: processes.filter(
                    (process) => process.sessionId !== processSessionId,
                ),
            },
        );
    };

    const readBackgroundProcess = async (
        sessionId: string,
        processSessionId: number,
        readOptions: { signal?: AbortSignal; waitMs?: number } = {},
    ): Promise<BackgroundProcessSnapshot | undefined> => {
        const query =
            readOptions.waitMs === undefined
                ? ""
                : `?waitMs=${encodeURIComponent(String(readOptions.waitMs))}`;
        const response = await requestJson(
            `sessions/${encodeURIComponent(sessionId)}/background-processes/${encodeURIComponent(String(processSessionId))}${query}`,
            readOptions.signal === undefined ? {} : { signal: readOptions.signal },
        );
        return response.status === 404 ? undefined : (response.data as BackgroundProcessSnapshot);
    };

    const resolveExternalToolCall = (
        sessionId: string,
        callId: string,
        resolution: ExternalToolCallResolution,
    ): MutationId => {
        const pending =
            sessionEntries.get(sessionId)?.store.session().pendingExternalToolCalls ?? [];
        return enqueueSessionUpdate(
            "resolve_external_tool_call",
            sessionId,
            `external-tool-calls/${encodeURIComponent(callId)}`,
            "POST",
            resolution,
            { pendingExternalToolCalls: pending.filter((call) => call.id !== callId) },
        );
    };

    const cancelScheduledMessage = (sessionId: string, scheduledMessageId: string): MutationId => {
        const id = nextMutationId();
        const mutation: PendingMutation = {
            acknowledged: false,
            action: "cancel_scheduled_message",
            entityKey: sessionKey(sessionId),
            id,
            sessionId,
            undo: () => undefined,
            applyOptimistic: (publish) => {
                const entry = sessionEntries.get(sessionId);
                if (entry === undefined) return () => undefined;
                const current = entry.store.session().scheduledMessages;
                const changed = entry.store.applyOptimisticSession({
                    scheduledMessages: current.map((message) =>
                        message.id === scheduledMessageId && message.status === "pending"
                            ? { ...message, status: "cancelled", updatedAt: now() }
                            : message,
                    ),
                });
                if (publish) publishSession(entry, changed.deltas);
                return changed.undo;
            },
            prepare: () => ({
                body: {},
                headers: { "x-rig-mutation-id": id },
                method: "POST",
                url: endpointUrl(
                    options.endpoint,
                    `sessions/${encodeURIComponent(sessionId)}/scheduled-messages/${encodeURIComponent(scheduledMessageId)}/cancel`,
                ),
            }),
            matchesAuthoritative: (data) =>
                (data as { message?: { id?: unknown; status?: unknown } } | null)?.message?.id ===
                    scheduledMessageId &&
                (data as { message?: { status?: unknown } } | null)?.message?.status ===
                    "cancelled",
        };
        return enqueue(mutation);
    };

    const recordActivity = (sessionId: string): MutationId => {
        const id = nextMutationId();
        return enqueue({
            acknowledged: false,
            action: "record_activity",
            applyOptimistic: () => () => undefined,
            entityKey: sessionKey(sessionId),
            id,
            prepare: () => ({
                headers: { "x-rig-mutation-id": id },
                method: "POST",
                url: endpointUrl(
                    options.endpoint,
                    `sessions/${encodeURIComponent(sessionId)}/activity`,
                ),
            }),
            undo: () => undefined,
        });
    };

    const connectTerminalPresence = async (
        sessionId: string,
        presenceOptions: { focused?: boolean; targetPid: number },
    ): Promise<TerminalPresence> => {
        const connectionId = nextMutationId();
        let focused = presenceOptions.focused === true;
        let presenceClosed = false;
        let inFlight: Promise<void> | undefined;
        const heartbeat = async (): Promise<void> => {
            await requestJson(
                `sessions/${encodeURIComponent(sessionId)}/terminal-connections/${encodeURIComponent(connectionId)}`,
                {
                    body: JSON.stringify({
                        connectionId,
                        focused,
                        targetPid: presenceOptions.targetPid,
                    }),
                    headers: { "content-type": "application/json" },
                    method: "PUT",
                },
            );
        };
        const sendHeartbeat = (): Promise<void> => {
            if (presenceClosed) return Promise.resolve();
            inFlight ??= heartbeat()
                .catch(() => undefined)
                .finally(() => {
                    inFlight = undefined;
                });
            return inFlight;
        };
        await heartbeat();
        const timer = setInterval(() => void sendHeartbeat(), 5_000);
        const closeLocally = (): void => {
            if (presenceClosed) return;
            presenceClosed = true;
            clearInterval(timer);
            presenceClosers.delete(closeLocally);
        };
        presenceClosers.add(closeLocally);
        return {
            connectionId,
            close: async () => {
                if (presenceClosed) return;
                closeLocally();
                await inFlight;
                await requestJson(
                    `sessions/${encodeURIComponent(sessionId)}/terminal-connections/${encodeURIComponent(connectionId)}`,
                    { method: "DELETE" },
                ).then(() => undefined);
            },
            setFocused: async (nextFocused) => {
                if (presenceClosed) return;
                focused = nextFocused;
                await sendHeartbeat();
            },
        };
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

    /**
     * Marks a chat as caught up on, clearing its unread state everywhere.
     *
     * This is what an interface without a terminal uses in place of focusing
     * one. Repeating it is harmless, so a retry after a lost answer settles on
     * the same state rather than failing.
     */
    const markSessionRead = (sessionId: string): MutationId => {
        const id = nextMutationId();
        const mutation: PendingMutation = {
            acknowledged: false,
            action: "mark_session_read",
            entityKey: sessionKey(sessionId),
            id,
            sessionId,
            undo: () => undefined,
            applyOptimistic: (publish) => {
                if (groupsEntry === undefined) return () => undefined;
                const entry = groupsEntry;
                const changed = entry.store.applyOptimisticSessionRead(sessionId);
                if (publish) publishGroups(entry, changed.deltas);
                return changed.undo;
            },
            prepare: () => ({
                headers: { "x-rig-mutation-id": id },
                method: "POST",
                url: endpointUrl(
                    options.endpoint,
                    `sessions/${encodeURIComponent(sessionId)}/read`,
                ),
            }),
            matchesAuthoritative: (data) => responseEntity(data, "session")?.unread === undefined,
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

    // Finish notifications are told from the catalog, so a caller that wants
    // them gets it loaded and followed without opening a view of its own.
    if (options.onSessionFinished !== undefined) startGroupEntry(createGroupEntry());

    return {
        archiveWorkspace,
        compatibility: () => compatibility,
        markSessionRead,
        close: () => {
            if (closed) return;
            for (const closePresence of [...presenceClosers]) closePresence();
            closed = true;
            if (gitWatchTimer !== undefined) clearTimeout(gitWatchTimer);
            gitWatchTimer = undefined;
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
            inboxEntry?.subscribers.clear();
            inboxEntry = undefined;
            for (const entry of timelineEntries.values()) {
                entry.controller.abort();
                entry.detachRoot();
                entry.subscribers.clear();
            }
            timelineEntries.clear();
        },
        answerUserInput,
        attachSecret,
        cancelScheduledMessage,
        clearGoal,
        compactSession,
        connectGroups,
        connectInbox,
        connectProviderUsage,
        connectSession,
        connectTerminalPresence,
        connectTimeline,
        createWorkspace,
        createSession,
        detachSecret,
        forkSession,
        readBackgroundProcess,
        recordActivity,
        renameGroup,
        resolveExternalToolCall,
        resetSession,
        rewindSession,
        runShellCommand,
        sendMessage,
        setDraft,
        setAppendSystemPrompt,
        setEffort,
        setPermissionMode,
        setServiceTier,
        setGoal,
        setGoalStatus,
        setSessionArchived,
        stopRun,
        stopBackgroundProcess,
        stopBackgroundProcesses,
        stopWorkflow,
        switchModel,
    };
}

/** One chart per scope and filter, so two identical views share a load. */
function timelineKey(subscription: RigTimelineSubscriptionOptions): string {
    const scope = subscription.scope;
    const target =
        scope.kind === "global"
            ? "global"
            : scope.kind === "project"
              ? `project:${scope.projectId}`
              : scope.kind === "workspace"
                ? `workspace:${scope.projectId}:${scope.workspaceId}`
                : `session:${scope.sessionId}`;
    return `timeline:${target}:${String(subscription.includeArchived ?? false)}:${String(subscription.since ?? "")}`;
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

function uniqueAppend(values: readonly string[], ...added: readonly string[]): readonly string[] {
    return [...new Set([...values, ...added])];
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

function humanProviderUsageError(error: unknown): string {
    if (error instanceof Error && error.message.length > 0) return error.message;
    return "Rig could not read how much of each provider has been used.";
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

/**
 * Loads the catalog by request-response.
 *
 * Entities never travel on the stream, so this is how a client learns what
 * exists. It is called after the stream is open, which is what makes the load
 * safe to rebase: anything that changes while it is in flight arrives on the
 * stream carrying a cursor.
 */
async function fetchTimeline(
    endpoint: string,
    token: string,
    request: typeof fetch,
    entry: { includeArchived: boolean; scope: TimelineScope; since?: number },
    signal: AbortSignal,
): Promise<GetTimelineResponse> {
    const response = await request(endpointUrl(endpoint, "/timeline"), {
        body: JSON.stringify({
            includeArchived: entry.includeArchived,
            scope: entry.scope,
            ...(entry.since === undefined ? {} : { since: entry.since }),
        }),
        headers: {
            accept: "application/json",
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
        },
        method: "POST",
        signal,
    });
    if (!response.ok) {
        throw new Error(`Rig could not load the timeline (${String(response.status)}).`);
    }
    return (await readResponseBody(response)) as GetTimelineResponse;
}

async function fetchCatalog(
    endpoint: string,
    token: string,
    request: typeof globalThis.fetch,
    signal: AbortSignal,
): Promise<GlobalStreamHello> {
    const response = await request(endpointUrl(endpoint, "catalog"), {
        headers: { accept: "application/json", authorization: `Bearer ${token}` },
        signal,
    });
    if (!response.ok) throw new Error(`Rig answered with ${String(response.status)}.`);
    return (await response.json()) as GlobalStreamHello;
}

async function fetchGitWatch(
    endpoint: string,
    token: string,
    entities: readonly GitWatchEntity[],
    request: typeof globalThis.fetch,
    signal: AbortSignal,
): Promise<readonly GlobalEvent[]> {
    const response = await request(endpointUrl(endpoint, "git/watch"), {
        body: JSON.stringify({ entities }),
        headers: {
            accept: "application/json",
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
        },
        method: "POST",
        signal,
    });
    if (response.status === 404 || response.status === 503) return [];
    if (!response.ok) throw new Error(`Rig answered with ${String(response.status)}.`);
    return ((await response.json()) as GitWatchResponse).snapshots;
}

/**
 * Loads everything needed to start showing a session, by request-response.
 *
 * The reply states the position in the live stream it reflects, so the events
 * that arrive after it can be replayed on top rather than guessed about.
 */
async function fetchSessionState(
    endpoint: string,
    token: string,
    sessionId: string,
    turnLimit: number | undefined,
    after: string | undefined,
    request: typeof globalThis.fetch,
    signal: AbortSignal,
): Promise<SessionStateResponse> {
    const query = new URLSearchParams();
    if (turnLimit !== undefined) query.set("turns", String(turnLimit));
    // The newest message already held, so the daemon sends only what follows it.
    if (after !== undefined) query.set("after", after);
    const path = `sessions/${encodeURIComponent(sessionId)}/state`;
    const url = endpointUrl(endpoint, query.size === 0 ? path : `${path}?${query.toString()}`);
    const response = await request(url, {
        headers: { accept: "application/json", authorization: `Bearer ${token}` },
        signal,
    });
    if (!response.ok) throw new Error(`Rig answered with ${String(response.status)}.`);
    let state = (await response.json()) as SessionStateResponse;
    if (state.append !== true || state.transcript === undefined) return state;

    let transcript = state.transcript;
    while (!transcript.complete) {
        const pageAnchor = newestMessageEventId(transcript);
        if (pageAnchor === undefined) {
            throw new Error("Rig returned a forward transcript page without a message cursor.");
        }
        const page = await fetchTranscriptAfter(
            endpoint,
            token,
            sessionId,
            pageAnchor,
            request,
            signal,
        );
        const nextAnchor = newestMessageEventId(page);
        if (!page.complete && (nextAnchor === undefined || nextAnchor === pageAnchor)) {
            throw new Error("Rig returned a forward transcript page that made no progress.");
        }
        transcript = mergeForwardTranscriptWindow(transcript, page, page.complete);
    }
    state = {
        ...state,
        transcript,
        ...(state.session === undefined
            ? {}
            : {
                  session: {
                      ...state.session,
                      snapshot: { ...state.session.snapshot, messages: transcript.messages },
                  },
              }),
    };
    return state;
}

async function fetchTranscriptAfter(
    endpoint: string,
    token: string,
    sessionId: string,
    after: string,
    request: typeof globalThis.fetch,
    signal: AbortSignal,
): Promise<SessionTranscriptWindow> {
    const url = endpointUrl(
        endpoint,
        `sessions/${encodeURIComponent(sessionId)}/transcript?after=${encodeURIComponent(after)}`,
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

function newestMessageEventId(transcript: SessionTranscriptWindow): string | undefined {
    let newest: string | undefined;
    for (const message of transcript.messages) {
        const eventId = transcript.messageEventId?.[message.id];
        if (eventId !== undefined && (newest === undefined || eventId > newest)) newest = eventId;
    }
    return newest;
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
