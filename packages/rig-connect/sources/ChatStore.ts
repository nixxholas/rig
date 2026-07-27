import { projectToolPresentation, type ToolPresentation } from "./ToolPresentation.js";
import type {
    AgentBlock,
    AgentLoopEvent,
    AgentMessage,
    BackgroundProcess,
    ContentBlock,
    GitChangeSnapshot,
    Message,
    PendingSteeringMessage,
    PermissionReviewState,
    ProtocolSession,
    SessionActivity,
    SessionGoal,
    SessionStatus,
    SessionEvent,
    SessionTask,
    SessionStreamHello,
    SessionTokenCount,
    SessionTranscriptWindow,
    SessionUsageSnapshot,
    ShellCommandState,
    SubagentSummary,
    ToolCallBlock,
    ToolCallPresentation,
    ToolResultBlock,
    ToolResultPresentation,
    Usage,
    UserMessage,
    UserInputRequest,
} from "./protocol.js";
import type {
    ActiveTurn,
    AgentTextElement,
    ChatDelta,
    ChatElement,
    ConnectionState,
    SessionState,
    SessionUsage,
    SystemNoticeElement,
    ThinkingElement,
    ToolCallElement,
    TurnEndElement,
    UserMessageElement,
} from "./ChatElement.js";
import { groupToolCalls } from "./groupToolCalls.js";
import { mergeTranscriptWindow } from "./mergeTranscriptWindow.js";

const IDLE_ACTIVITY: SessionActivity = { kind: "idle", label: "Idle", since: 0 };

/**
 * The live chat state for one session.
 *
 * It holds the element list and the session state, applies protocol events to
 * them, and reports what changed. It knows nothing about transport: the same
 * store is driven by a live stream, by a replay in a test, or by a reconnect.
 *
 * The list is immutable from the outside. An element that did not change keeps
 * its identity across an update, so a consumer can rely on referential equality
 * to decide what to re-render.
 */
export class ChatStore {
    #elements: readonly ChatElement[] = [];
    /** Authoritative insertion order before pending steering is pinned to the tail. */
    #chronologicalElementIds: string[] = [];
    #session: SessionState;
    #turnId: string | undefined;
    #turnStartedAt = new Map<string, number>();
    #openTurnIds: string[] = [];
    /** Elements by id, so a delta reaches its element without scanning the list. */
    #byId = new Map<string, ChatElement>();
    /** In-flight tool calls by the daemon's tool-call id. */
    #toolCallElementIds = new Map<string, string>();
    /** Streaming blocks of the message being generated, keyed by content index. */
    #streamingElementIds = new Map<number, string>();
    #streamingMessageId: string | undefined;
    /** Ids of messages already applied, so a replayed message is not duplicated. */
    #appliedMessageIds = new Set<string>();
    #compactionElementIds = new Map<string, string>();
    #retrying = false;
    #sequence = 0;
    /** Bumped whenever the element list actually changes. */
    #revision = 0;
    /** Position of each element, so an update never scans the list. */
    #indexById = new Map<string, number>();
    /** Set when a tool call appeared or moved, which is all grouping depends on. */
    #groupingDirty = false;
    /** What the current turn has cost so far, summed across its inferences. */
    #turnUsage: Usage | undefined;
    /**
     * Raw call presentations, kept until the matching result arrives.
     *
     * A call and its result describe the same work at two moments and project
     * into one value, so the earlier half has to survive until the later one is
     * known. Entries are dropped as results land and cleared on reset.
     */
    #callPresentations = new Map<string, ToolCallPresentation>();
    /**
     * The transcript window the list was built from.
     *
     * A recovery that cannot resume is answered with the newest turns only, and
     * this is what the older turns are kept in so they can be merged back in
     * front of it.
     */
    #loadedTranscript: SessionTranscriptWindow | undefined;
    /** Invalidates an earlier-page response whenever the transcript is replaced. */
    #transcriptGeneration = 0;
    /**
     * Elements from before a rebuild, so identical rows keep their reference.
     *
     * Set only while a transcript is being rebuilt, which bounds the comparison
     * to that work rather than paying for it on every append.
     */
    #priorElements: Map<string, ChatElement> | undefined;

    constructor(sessionId: string) {
        this.#session = {
            activity: IDLE_ACTIVITY,
            archived: false,
            backgroundProcesses: [],
            connection: "connecting",
            cwd: "",
            modelLocked: false,
            modelId: "",
            models: [],
            orderKey: "",
            pendingSteeringMessages: [],
            pendingUserInputs: [],
            permissionMode: "",
            permissionReviews: [],
            projectId: "",
            providerId: "",
            loadingMore: false,
            sessionId,
            shellCommands: [],
            status: "idle",
            subagents: [],
            tasks: [],
            transcriptComplete: true,
        };
    }

    /**
     * The run to ask for earlier turns from, or undefined when there is nothing
     * older to ask for.
     */
    earliestRunId(): string | undefined {
        if (this.#session.transcriptComplete) return undefined;
        return this.#loadedTranscript?.turns[0]?.runId;
    }

    /**
     * Atomically consumes one rendered load token.
     *
     * A virtual list may call this more than once before React commits the state
     * change. The first call marks the token in flight synchronously; duplicates
     * and stale renders therefore become no-ops before any request is created.
     */
    startLoadingMore(token: string):
        | {
              anchor: { before: string; generation: number };
              deltas: readonly ChatDelta[];
          }
        | undefined {
        const before = this.earliestRunId();
        if (
            before === undefined ||
            this.#session.loadingMore ||
            token !== this.#session.loadMoreToken
        ) {
            return undefined;
        }
        const sessionBefore = this.#session;
        this.#session = {
            ...withoutKeys(this.#session, ["loadMoreError"]),
            loadingMore: true,
        };
        return {
            anchor: { before, generation: this.#transcriptGeneration },
            deltas: this.#finish([], this.#revision, sessionBefore),
        };
    }

    /** Reports that loading more history failed, in words a UI can show. */
    failLoadingMore(
        anchor: { before: string; generation: number },
        message: string,
    ): readonly ChatDelta[] {
        if (
            anchor.generation !== this.#transcriptGeneration ||
            anchor.before !== this.earliestRunId()
        ) {
            return [];
        }
        const before = this.#session;
        this.#session = { ...this.#session, loadMoreError: message, loadingMore: false };
        return this.#finish([], this.#revision, before);
    }

    /**
     * Adds a page of earlier turns in front of the list.
     *
     * The page is older than everything already loaded, so the existing rows keep
     * both their order and their identity and only the new turns are built.
     */
    prependEarlier(
        page: SessionTranscriptWindow,
        anchor?: { before: string; generation: number },
    ): readonly ChatDelta[] {
        const deltas: ChatDelta[] = [];
        const revisionBefore = this.#revision;
        const sessionBefore = this.#session;
        if (
            anchor !== undefined &&
            (anchor.generation !== this.#transcriptGeneration ||
                anchor.before !== this.earliestRunId())
        ) {
            this.#session = {
                ...withoutKeys(this.#session, ["loadMoreError"]),
                loadingMore: false,
            };
            return this.#finish(deltas, revisionBefore, sessionBefore);
        }
        const loaded = this.#loadedTranscript;
        const messageCreatedAt = {
            ...(page.messageCreatedAt ?? {}),
            ...(loaded?.messageCreatedAt ?? {}),
        };
        const merged: SessionTranscriptWindow = {
            complete: page.complete,
            ...(Object.keys(messageCreatedAt).length === 0 ? {} : { messageCreatedAt }),
            messages: [...page.messages, ...(loaded?.messages ?? [])],
            turns: [...page.turns, ...(loaded?.turns ?? [])],
        };
        this.#resetTranscript(merged.messages, deltas, merged, this.#session.activeTurn);
        const loadMoreToken = merged.complete ? undefined : historyToken(merged);
        this.#session = {
            ...withoutKeys(this.#session, ["loadMoreError", "loadMoreToken"]),
            ...(loadMoreToken === undefined ? {} : { loadMoreToken }),
            loadingMore: false,
            transcriptComplete: merged.complete,
        };
        return this.#finish(deltas, revisionBefore, sessionBefore);
    }

    elements(): readonly ChatElement[] {
        return this.#elements;
    }

    session(): SessionState {
        return this.#session;
    }

    /**
     * Applies the opening frame of a stream.
     *
     * A first connection carries the whole session and rebuilds the list from its
     * transcript. A resume carries only what the event log cannot replay, so the
     * list is left alone and the in-flight message is restored.
     */
    applyHello(hello: SessionStreamHello): readonly ChatDelta[] {
        const deltas: ChatDelta[] = [];
        const revisionBefore = this.#revision;
        const sessionBefore = this.#session;
        if (hello.session !== undefined) {
            const merged =
                hello.transcript === undefined
                    ? undefined
                    : mergeTranscriptWindow(this.#loadedTranscript, hello.transcript);
            this.#resetFromSession(hello.session, merged, hello.usage);
            // The opening frame carries a bounded window, so the caller is told
            // whether the conversation began before the first element it has.
            const loadMoreToken =
                this.#loadedTranscript?.complete === false
                    ? historyToken(this.#loadedTranscript)
                    : undefined;
            this.#session = {
                ...withoutKeys(this.#session, ["loadMoreToken"]),
                ...(loadMoreToken === undefined ? {} : { loadMoreToken }),
                transcriptComplete: this.#loadedTranscript?.complete ?? true,
            };
        }
        this.#setActivity(hello.activity, deltas);
        if (hello.partial !== undefined) {
            this.#applyPartialMessage(hello.partial.message, hello.partial.runId, deltas);
        }
        return this.#finish(deltas, revisionBefore, sessionBefore);
    }

    setConnection(connection: ConnectionState): readonly ChatDelta[] {
        if (this.#session.connection === connection) return [];
        this.#session = { ...this.#session, connection };
        return [
            { type: "connection_changed", connection },
            { type: "session_changed", session: this.#session },
        ];
    }

    /** Applies one session event. Unrecognised events are ignored, not an error. */
    apply(event: SessionEvent): readonly ChatDelta[] {
        const deltas: ChatDelta[] = [];
        const revisionBefore = this.#revision;
        const sessionBefore = this.#session;
        switch (event.type) {
            case "session_status_changed": {
                // A replayed or delayed event can restate the status the store
                // already holds. Keeping the same session value means React
                // consumers are not re-rendered for news they already have.
                const status = (event.data as { status: SessionStatus }).status;
                if (status !== this.#session.status) {
                    this.#session = { ...this.#session, status };
                }
                break;
            }
            case "session_archived": {
                const archived = (event.data as { archived: boolean }).archived;
                if (archived !== this.#session.archived) {
                    this.#session = { ...this.#session, archived };
                }
                break;
            }
            case "session_activity_changed":
                this.#setActivity((event.data as { activity: SessionActivity }).activity, deltas);
                break;
            case "session_git_changed":
                this.#session = {
                    ...this.#session,
                    git: applicationGit((event.data as { git: GitChangeSnapshot }).git),
                };
                break;
            case "session_context_changed":
                {
                    const tokens = (event.data as { sessionTokenCount: SessionTokenCount })
                        .sessionTokenCount;
                    this.#session = {
                        ...this.#session,
                        tokens,
                        ...(this.#session.usage === undefined
                            ? {}
                            : { usage: { ...this.#session.usage, sessionTokenCount: tokens } }),
                    };
                }
                break;
            case "session_configuration_changed": {
                const data = event.data as {
                    effort?: string;
                    modelId: string;
                    providerId?: string;
                    serviceTier: string | null;
                };
                const providerId = data.providerId ?? this.#session.providerId;
                // Effort and service tier are cleared by omission and by null
                // respectively, so both are written every time rather than
                // merged, or a cleared value would linger.
                this.#session = {
                    ...withoutKeys(this.#session, ["effort", "serviceTier"]),
                    modelId: data.modelId,
                    providerId,
                    ...(this.#session.usage === undefined
                        ? {}
                        : {
                              usage: {
                                  ...this.#session.usage,
                                  currentProviderId: providerId,
                              },
                          }),
                    ...(data.effort === undefined ? {} : { effort: data.effort }),
                    ...(data.serviceTier === null ? {} : { serviceTier: data.serviceTier }),
                };
                break;
            }
            case "session_draft_changed": {
                const data = event.data as { draft?: string; updatedAt: number };
                if (
                    this.#session.draftUpdatedAt !== undefined &&
                    data.updatedAt < this.#session.draftUpdatedAt
                ) {
                    break;
                }
                this.#session = {
                    ...withoutKeys(this.#session, ["draft"]),
                    draftUpdatedAt: data.updatedAt,
                    ...(data.draft === undefined ? {} : { draft: data.draft }),
                };
                break;
            }
            case "permission_mode_changed":
                this.#session = {
                    ...this.#session,
                    permissionMode: (event.data as { permissionMode: string }).permissionMode,
                };
                break;
            case "session_title_changed": {
                const { recap, status, title } = event.data as {
                    recap?: string;
                    status: string;
                    title?: string;
                };
                // Generating and error events report only metadata activity; the
                // daemon deliberately omits the good metadata it still retains.
                // A settled idle/ready event is authoritative and may clear it.
                if (title !== undefined || recap !== undefined) {
                    this.#session = {
                        ...this.#session,
                        ...(title === undefined ? {} : { title }),
                        ...(recap === undefined ? {} : { recap }),
                    };
                }
                if (status === "idle" || status === "ready") {
                    const clear: ("recap" | "title")[] = [];
                    if (title === undefined) clear.push("title");
                    if (recap === undefined) clear.push("recap");
                    this.#session = withoutKeys(this.#session, clear);
                }
                break;
            }
            case "user_input_requested": {
                const request = event.data as UserInputRequest;
                this.#session = {
                    ...this.#session,
                    pendingUserInputs: [
                        ...this.#session.pendingUserInputs.filter(
                            (pending) => pending.requestId !== request.requestId,
                        ),
                        request,
                    ],
                };
                break;
            }
            case "user_input_resolved": {
                const { requestId } = event.data as { requestId: string };
                this.#session = {
                    ...this.#session,
                    pendingUserInputs: this.#session.pendingUserInputs.filter(
                        (pending) => pending.requestId !== requestId,
                    ),
                };
                break;
            }
            case "tasks_changed":
                this.#session = {
                    ...this.#session,
                    tasks: (event.data as { tasks: readonly SessionTask[] }).tasks,
                };
                break;
            case "goal_changed": {
                const { goal } = event.data as { goal: SessionGoal | null };
                this.#session =
                    goal === null
                        ? withoutKeys(this.#session, ["goal"])
                        : { ...this.#session, goal };
                break;
            }
            case "subagent_changed": {
                const { subagent } = event.data as { subagent: SubagentSummary };
                this.#session = {
                    ...this.#session,
                    subagents: [
                        ...this.#session.subagents.filter((known) => known.id !== subagent.id),
                        subagent,
                    ].sort((left, right) => left.createdAt - right.createdAt),
                };
                break;
            }
            case "shell_command_started": {
                const command = event.data as {
                    command: string;
                    commandId: string;
                    sessionId: number;
                };
                this.#setShellCommand({ ...command, status: "running" });
                break;
            }
            case "shell_command_finished": {
                const command = event.data as Omit<ShellCommandState, "status">;
                this.#setShellCommand({ ...command, status: "finished" });
                break;
            }
            case "steering_applied": {
                const applied = new Set(
                    (event.data as { messageIds: readonly string[] }).messageIds,
                );
                for (const messageId of applied) {
                    const elementId = `message:${messageId}`;
                    const element = this.#byId.get(elementId);
                    if (element?.kind === "user_message") {
                        this.#update(elementId, { delivery: "sent" });
                    }
                }
                this.#session = {
                    ...this.#session,
                    pendingSteeringMessages: this.#session.pendingSteeringMessages.filter(
                        (pending) => !applied.has(pending.message.id),
                    ),
                };
                this.#presentPendingSteeringAtTail();
                break;
            }
            case "message_submitted":
                this.#trackPendingSteering(event);
                this.#applySubmittedMessage(event, deltas);
                break;
            case "run_started":
                this.#startTurn((event.data as { runId: string }).runId, event.createdAt, deltas);
                break;
            case "inference_retry": {
                const data = event.data as { attempt: number; reason: string; runId: string };
                this.#appendRetry(event.id, data.runId, event.createdAt, data.attempt, data.reason);
                deltas.push({
                    attempt: data.attempt,
                    reason: data.reason,
                    type: "retry_started",
                });
                break;
            }
            case "agent_message":
                {
                    const data = event.data as { message: Message; runId: string };
                    if (data.message.role === "agent") this.#recordAgentUsage(data.message);
                    this.#applyMessage(data.message, event.createdAt, deltas, data.runId);
                }
                break;
            case "provider_quota_observed": {
                const data = event.data as {
                    providerId: string;
                    quota: SessionUsageSnapshot["quotas"][number]["quota"];
                };
                this.#recordProviderQuota(data.providerId, data.quota);
                break;
            }
            case "agent_event":
                this.#applyAgentEvent(
                    (event.data as { event: AgentLoopEvent }).event,
                    event.createdAt,
                    deltas,
                );
                break;
            case "run_finished": {
                const data = event.data as {
                    errorMessage?: string;
                    modelLocked: boolean;
                    runId: string;
                    stopReason: string;
                };
                this.#session = { ...this.#session, modelLocked: data.modelLocked };
                const outcome =
                    data.stopReason === "error"
                        ? "error"
                        : data.stopReason === "aborted"
                          ? "stopped"
                          : "success";
                this.#endTurn(data.runId, outcome, data.errorMessage, event.createdAt, deltas);
                break;
            }
            case "run_error": {
                const data = event.data as {
                    errorMessage: string;
                    modelLocked: boolean;
                    runId: string;
                };
                this.#session = {
                    ...this.#session,
                    modelLocked: data.modelLocked,
                };
                this.#endTurn(data.runId, "error", data.errorMessage, event.createdAt, deltas);
                break;
            }
            case "session_reset":
            case "session_rewound": {
                // Both carry the transcript as it stands afterwards, so the list
                // is rebuilt with real runs and closed turns rather than the
                // per-message boundaries the snapshot alone would imply.
                const data = event.data as {
                    snapshot: {
                        messages: readonly Message[];
                        modelId?: string;
                        providerId?: string;
                    };
                    transcript?: SessionTranscriptWindow;
                };
                const transcript =
                    data.transcript === undefined
                        ? undefined
                        : mergeTranscriptWindow(this.#loadedTranscript, data.transcript);
                this.#resetTranscript(data.snapshot.messages, deltas, transcript);
                const usage = this.#session.usage;
                const loadMoreToken =
                    transcript?.complete === false ? historyToken(transcript) : undefined;
                this.#session = {
                    ...withoutKeys(this.#session, ["loadMoreError", "loadMoreToken"]),
                    ...(loadMoreToken === undefined ? {} : { loadMoreToken }),
                    loadingMore: false,
                    transcriptComplete: transcript?.complete ?? true,
                    ...(event.type === "session_reset" ? { permissionReviews: [] } : {}),
                    ...(usage === undefined
                        ? {}
                        : event.type === "session_reset"
                          ? {
                                usage: applicationUsage({
                                    currentProviderId:
                                        data.snapshot.providerId ?? usage.currentProviderId,
                                    groups: [],
                                    observedQuota: [],
                                    quotas: usage.quotas,
                                    sessionTokenCount: {
                                        lastContextTokens: 0,
                                        totalTokens: 0,
                                    },
                                }),
                            }
                          : { usage: withoutUsageContext(usage) }),
                };
                break;
            }
            default:
                return [];
        }
        return this.#finish(deltas, revisionBefore, sessionBefore);
    }

    /**
     * Completes an application, reporting the list only when it really changed.
     *
     * Many events change an element without producing a delta of their own, so
     * the list revision rather than the delta list decides whether subscribers
     * are told the elements moved.
     */
    #finish(
        deltas: ChatDelta[],
        revisionBefore: number,
        sessionBefore: SessionState,
    ): readonly ChatDelta[] {
        this.#regroup();
        const elementsChanged = this.#revision !== revisionBefore;
        // The session value is replaced rather than mutated whenever any fact on
        // it changes, so an unchanged reference means there is nothing to report.
        // Comparing it here means a new fact is announced without every case
        // having to remember to push a delta of its own.
        const sessionChanged = this.#session !== sessionBefore;
        if (deltas.length === 0 && !elementsChanged && !sessionChanged) return [];
        if (!deltas.some((delta) => delta.type === "session_changed")) {
            deltas.push({ type: "session_changed", session: this.#session });
        }
        if (elementsChanged) {
            deltas.push({ type: "elements_changed", elements: this.#elements });
        }
        return deltas;
    }

    /**
     * Recomputes tool-call grouping when a tool call moved.
     *
     * Grouping is a whole-list scan, so it is skipped entirely for the events
     * that cannot affect it — which is nearly all of them, streaming text
     * deltas above all.
     */
    #regroup(): void {
        if (!this.#groupingDirty) return;
        this.#groupingDirty = false;
        const grouped = groupToolCalls(this.#elements);
        if (grouped === this.#elements) return;
        this.#elements = grouped;
        this.#revision += 1;
        for (const element of grouped) this.#byId.set(element.id, element);
    }

    #resetFromSession(
        session: ProtocolSession,
        transcript?: SessionTranscriptWindow,
        usage?: SessionUsageSnapshot,
    ): void {
        this.#session = {
            ...withoutKeys(this.#session, [
                "draft",
                "draftUpdatedAt",
                "effort",
                "goal",
                "git",
                "recap",
                "serviceTier",
                "title",
                "tokens",
                "usage",
                "workspaceId",
            ]),
            archived: session.archived,
            backgroundProcesses: session.backgroundProcesses ?? [],
            cwd: session.cwd,
            modelLocked: session.modelLocked,
            modelId: session.modelId,
            models: session.models,
            orderKey: session.orderKey,
            pendingSteeringMessages: session.pendingSteeringMessages ?? [],
            pendingUserInputs: session.pendingUserInputs,
            permissionReviews: session.permissionReviews ?? [],
            permissionMode: session.permissionMode,
            projectId: session.projectId,
            providerId: session.providerId,
            sessionId: session.id,
            shellCommands: session.shellCommands ?? [],
            status: session.status,
            subagents: session.subagents ?? [],
            tasks: session.tasks,
            ...(session.workspaceId === undefined ? {} : { workspaceId: session.workspaceId }),
            ...(session.draft === undefined ? {} : { draft: session.draft }),
            ...(session.draftUpdatedAt === undefined
                ? {}
                : { draftUpdatedAt: session.draftUpdatedAt }),
            ...(session.effort === undefined ? {} : { effort: session.effort }),
            ...(session.git === undefined ? {} : { git: applicationGit(session.git) }),
            ...(session.goal === undefined ? {} : { goal: session.goal }),
            ...(session.recap === undefined ? {} : { recap: session.recap }),
            ...(session.serviceTier === undefined ? {} : { serviceTier: session.serviceTier }),
            ...(session.title === undefined ? {} : { title: session.title }),
            ...(session.sessionTokenCount === undefined
                ? {}
                : { tokens: session.sessionTokenCount }),
            ...(usage === undefined ? {} : { usage: applicationUsage(usage) }),
        };
        this.#resetTranscript(
            session.snapshot.messages,
            [],
            transcript,
            session.activeTurn === undefined
                ? undefined
                : { startedAt: session.activeTurn.startedAt, turnId: session.activeTurn.runId },
            true,
        );
        for (const pending of session.pendingSteeringMessages ?? []) {
            this.#applyMessage(
                pending.message,
                pending.createdAt,
                [],
                pending.runId,
                "pending_steering",
            );
        }
        this.#priorElements = undefined;
    }

    /**
     * Rebuilds the list from a committed transcript.
     *
     * When the daemon reported turn boundaries the history is rebuilt as real
     * turns, each closed by its own `turn_end`, so scrolled-back history renders
     * the same way live output does. Without them each message becomes its own
     * turn, which is all that can honestly be said about messages whose run the
     * daemon no longer knows.
     */
    #resetTranscript(
        messages: readonly Message[],
        deltas: ChatDelta[],
        transcript?: SessionTranscriptWindow,
        activeTurn?: ActiveTurn,
        preservePriorElements = false,
    ): void {
        this.#transcriptGeneration += 1;
        if (this.#elements.length > 0) this.#revision += 1;
        // Copied, not aliased: the map this reads from is cleared just below.
        this.#priorElements = new Map(this.#byId);
        this.#elements = [];
        this.#chronologicalElementIds = [];
        this.#byId.clear();
        this.#indexById.clear();
        this.#groupingDirty = true;
        this.#toolCallElementIds.clear();
        this.#callPresentations.clear();
        this.#streamingElementIds.clear();
        this.#appliedMessageIds.clear();
        this.#compactionElementIds.clear();
        this.#streamingMessageId = undefined;
        this.#turnId = undefined;
        this.#turnStartedAt.clear();
        this.#openTurnIds = [];
        this.#turnUsage = undefined;
        this.#retrying = false;
        this.#session = withoutKeys(this.#session, ["activeTurn"]);
        this.#loadedTranscript = transcript;
        try {
            if (transcript !== undefined && transcript.turns.length > 0) {
                this.#rebuildTurns(transcript.messages, transcript, deltas, activeTurn);
                return;
            }
            for (const message of messages) {
                if (message.internal === true) continue;
                this.#turnId = `history:${message.id}`;
                this.#applyMessage(message, 0, deltas, this.#turnId);
            }
            this.#turnId = undefined;
            if (activeTurn !== undefined) {
                this.#rememberTurn(activeTurn.turnId, activeTurn.startedAt);
                this.#activateTurn(activeTurn.turnId, activeTurn.startedAt, deltas);
            }
        } finally {
            if (!preservePriorElements) this.#priorElements = undefined;
        }
    }

    /**
     * Replays committed history as the turns the daemon recorded.
     *
     * A turn that the daemon reported as finished is closed with a `turn_end`
     * carrying its real outcome and duration, so a footer rendered from history
     * matches what a client watching live would have seen. A turn still running
     * is left open for the live events to finish.
     */
    #rebuildTurns(
        messages: readonly Message[],
        transcript: SessionTranscriptWindow,
        deltas: ChatDelta[],
        activeTurn?: ActiveTurn,
    ): void {
        const byId = new Map(messages.map((message) => [message.id, message]));
        for (const turn of transcript.turns) {
            this.#turnId = turn.runId;
            this.#rememberTurn(turn.runId, turn.startedAt);
            const timeline = [
                ...turn.messageIds.flatMap((messageId, order) => {
                    const message = byId.get(messageId);
                    return message === undefined
                        ? []
                        : [
                              {
                                  at: transcript.messageCreatedAt?.[messageId] ?? turn.startedAt,
                                  kind: "message" as const,
                                  message,
                                  order,
                              },
                          ];
                }),
                ...(turn.retries ?? []).map((retry, order) => ({
                    at: retry.createdAt,
                    kind: "retry" as const,
                    order: turn.messageIds.length + order,
                    retry,
                })),
            ].sort((left, right) => left.at - right.at || left.order - right.order);
            for (const item of timeline) {
                if (item.kind === "message") {
                    this.#applyMessage(item.message, item.at, deltas, turn.runId);
                } else {
                    this.#appendRetry(
                        item.retry.id,
                        turn.runId,
                        item.retry.createdAt,
                        item.retry.attempt,
                        item.retry.reason,
                    );
                }
            }
            if (turn.endedAt === undefined) continue;
            this.#endTurn(
                turn.runId,
                turn.outcome ?? "success",
                turn.errorMessage,
                turn.endedAt,
                deltas,
                false,
            );
        }
        const restored =
            activeTurn ??
            this.#openTurnIds
                .map((turnId) => {
                    const startedAt = this.#turnStartedAt.get(turnId);
                    return startedAt === undefined ? undefined : { startedAt, turnId };
                })
                .find((turn): turn is ActiveTurn => turn !== undefined);
        if (restored === undefined) {
            this.#turnId = undefined;
        } else {
            this.#rememberTurn(restored.turnId, restored.startedAt);
            this.#activateTurn(restored.turnId, restored.startedAt, deltas);
        }
    }

    #setActivity(activity: SessionActivity, deltas: ChatDelta[]): void {
        const wasRetrying = this.#retrying;
        this.#session = { ...this.#session, activity };
        deltas.push({ type: "session_changed", session: this.#session });
        this.#retrying = activity.retry !== undefined;
        if (!this.#retrying && wasRetrying) deltas.push({ type: "retry_finished" });
    }

    #startTurn(runId: string, at: number, deltas: ChatDelta[]): void {
        const startedAt = this.#turnStartedAt.get(runId) ?? at;
        this.#rememberTurn(runId, startedAt);
        this.#activateTurn(runId, startedAt, deltas);
    }

    #rememberTurn(runId: string, startedAt: number): void {
        if (!this.#turnStartedAt.has(runId)) this.#turnStartedAt.set(runId, startedAt);
        if (!this.#openTurnIds.includes(runId)) this.#openTurnIds.push(runId);
    }

    #activateTurn(runId: string, startedAt: number, deltas: ChatDelta[]): void {
        if (
            this.#session.activeTurn?.turnId === runId &&
            this.#session.activeTurn.startedAt === startedAt
        ) {
            this.#turnId = runId;
            return;
        }
        this.#turnId = runId;
        this.#session = { ...this.#session, activeTurn: { startedAt, turnId: runId } };
        this.#streamingElementIds.clear();
        this.#streamingMessageId = undefined;
        this.#turnUsage = undefined;
        deltas.push({ type: "turn_started", startedAt, turnId: runId });
    }

    /**
     * Closes the current turn with its final element.
     *
     * The guarantee that a turn always ends is kept here: whatever state the turn
     * was in, it gains exactly one `turn_end` element and no more.
     */
    #endTurn(
        turnId: string,
        outcome: TurnEndElement["outcome"],
        errorMessage: string | undefined,
        at: number,
        deltas: ChatDelta[],
        advance = true,
    ): void {
        const startedAt = this.#turnStartedAt.get(turnId);
        if (startedAt === undefined) return;
        // Text and tool calls left open by an interrupted turn are closed here so
        // no element stays perpetually in progress.
        if (this.#session.activeTurn?.turnId === turnId) this.#closeOpenElements(outcome);
        this.#append({
            createdAt: at,
            elapsedMs: Math.max(0, at - startedAt),
            endedAt: at,
            // Derived from the turn rather than a counter: a turn ends exactly
            // once, and rebuilding the list after a recovery has to produce the
            // same identity so a reader keeps their place.
            id: `turn:${turnId}`,
            kind: "turn_end",
            outcome,
            startedAt,
            turnId,
            ...(errorMessage === undefined ? {} : { errorMessage }),
            // Omitted rather than zeroed when nothing was reported, because a
            // free turn and an unmeasured one are different statements.
            ...(this.#turnUsage === undefined ? {} : { usage: this.#turnUsage }),
        });
        this.#turnUsage = undefined;
        this.#turnStartedAt.delete(turnId);
        this.#openTurnIds = this.#openTurnIds.filter((openTurnId) => openTurnId !== turnId);
        if (this.#session.activeTurn?.turnId === turnId) {
            this.#session = withoutKeys(this.#session, ["activeTurn"]);
            this.#turnId = undefined;
            this.#streamingElementIds.clear();
            this.#streamingMessageId = undefined;
        }
        deltas.push({ endedAt: at, outcome, startedAt, turnId, type: "turn_ended" });
        if (!advance) return;
        const nextTurnId = this.#openTurnIds[0];
        const nextStartedAt =
            nextTurnId === undefined ? undefined : this.#turnStartedAt.get(nextTurnId);
        if (nextTurnId !== undefined && nextStartedAt !== undefined) {
            this.#activateTurn(nextTurnId, nextStartedAt, deltas);
        }
    }

    #closeOpenElements(outcome: TurnEndElement["outcome"]): void {
        for (const elementId of this.#streamingElementIds.values()) {
            const element = this.#byId.get(elementId);
            if (element === undefined) continue;
            if (element.kind === "agent_text" || element.kind === "thinking") {
                if (!element.complete) this.#update(elementId, { complete: true });
            }
        }
        for (const elementId of this.#toolCallElementIds.values()) {
            const element = this.#byId.get(elementId);
            if (element?.kind !== "tool_call") continue;
            if (element.status === "pending" || element.status === "running") {
                this.#update(elementId, {
                    argumentsComplete: true,
                    status: outcome === "stopped" ? "interrupted" : "failed",
                });
            }
            // No result can arrive for this call now, so the raw half kept for
            // pairing is dead. Its projection already reached the element; only
            // the wire value is dropped. Without this an interrupted turn leaks
            // one entry per tool call for the life of the session.
            this.#callPresentations.delete(elementId);
        }
        this.#toolCallElementIds.clear();
    }

    #applySubmittedMessage(event: SessionEvent, deltas: ChatDelta[]): void {
        const data = event.data as {
            delivery?: "run" | "steer";
            displayText: string;
            message: Message;
            runId: string;
        };
        if (data.delivery === "run") {
            this.#rememberTurn(data.runId, event.createdAt);
            if (this.#session.activeTurn === undefined) {
                this.#activateTurn(data.runId, event.createdAt, deltas);
            }
        }
        this.#applyMessage(
            data.message,
            event.createdAt,
            deltas,
            data.runId,
            data.delivery === "steer" ? "pending_steering" : "sent",
        );
    }

    #trackPendingSteering(event: SessionEvent): void {
        const data = event.data as {
            delivery?: "run" | "steer";
            message: UserMessage;
            runId: string;
        };
        if (data.delivery !== "steer") return;
        const pending: PendingSteeringMessage = {
            createdAt: event.createdAt,
            message: data.message,
            runId: data.runId,
        };
        this.#session = {
            ...this.#session,
            pendingSteeringMessages: [
                ...this.#session.pendingSteeringMessages.filter(
                    (known) => known.message.id !== pending.message.id,
                ),
                pending,
            ],
        };
    }

    #setShellCommand(command: ShellCommandState): void {
        const knownIndex = this.#session.shellCommands.findIndex(
            (known) => known.commandId === command.commandId,
        );
        const shellCommands =
            knownIndex === -1
                ? [...this.#session.shellCommands, command].slice(-100)
                : this.#session.shellCommands.map((known, index) =>
                      index === knownIndex ? command : known,
                  );
        this.#session = { ...this.#session, shellCommands };
    }

    #appendRetry(id: string, turnId: string, at: number, attempt: number, reason: string): void {
        this.#append({
            attempt,
            createdAt: at,
            id: `retry:${id}`,
            kind: "retry",
            reason,
            turnId,
        });
    }

    #recordAgentUsage(message: AgentMessage): void {
        if (
            message.usage === undefined ||
            message.providerId === undefined ||
            message.requestedModelId === undefined
        ) {
            return;
        }
        const modelId = message.responseModel ?? message.requestedModelId;
        this.#recordUsageGroup({
            kind: "attributed",
            modelId,
            providerId: message.providerId,
            requestedModelId: message.requestedModelId,
            ...(message.responseModel === undefined
                ? {}
                : { responseModel: message.responseModel }),
            usage: message.usage,
        });
        const usage = this.#session.usage;
        if (usage === undefined) return;
        this.#session = {
            ...this.#session,
            usage: applicationUsage({
                ...usage,
                context: {
                    approximate: false,
                    modelId,
                    providerId: message.providerId,
                    requestedModelId: message.requestedModelId,
                    ...(message.responseModel === undefined
                        ? {}
                        : { responseModel: message.responseModel }),
                    totalTokens: message.usage.totalTokens,
                },
                currentProviderId: message.providerId,
            }),
        };
    }

    #recordUsageGroup(group: SessionUsageSnapshot["groups"][number]): void {
        const current =
            this.#session.usage ??
            applicationUsage({
                currentProviderId: this.#session.providerId,
                groups: [],
                observedQuota: [],
                quotas: [],
                sessionTokenCount: this.#session.tokens ?? {
                    lastContextTokens: 0,
                    totalTokens: 0,
                },
            });
        const index = current.groups.findIndex(
            (known) =>
                known.providerId === group.providerId &&
                known.modelId === group.modelId &&
                known.role === group.role,
        );
        const groups =
            index === -1
                ? [...current.groups, group]
                : current.groups.map((known, knownIndex) =>
                      knownIndex === index
                          ? { ...known, usage: addUsage(known.usage, group.usage) }
                          : known,
                  );
        this.#session = {
            ...this.#session,
            usage: applicationUsage({ ...current, groups }),
        };
    }

    #recordProviderQuota(
        providerId: string,
        quota: SessionUsageSnapshot["quotas"][number]["quota"],
    ): void {
        const usage = this.#session.usage;
        if (usage === undefined) return;
        const known = usage.quotas.find((entry) => entry.providerId === providerId);
        if (known !== undefined && known.quota.capturedAt > quota.capturedAt) return;
        const quotas = [
            ...usage.quotas.filter((entry) => entry.providerId !== providerId),
            { providerId, quota },
        ];
        this.#session = { ...this.#session, usage: { ...usage, quotas } };
    }

    /** Applies one committed message, expanding its blocks into elements. */
    #applyMessage(
        message: Message,
        at: number,
        deltas: ChatDelta[],
        turnId = this.#turnId,
        delivery: UserMessageElement["delivery"] = "sent",
    ): void {
        if (message.internal === true) return;
        if (this.#appliedMessageIds.has(message.id)) {
            if (message.role === "agent") this.#reconcileAgentMessage(message, at);
            if (message.role === "user" && delivery === "pending_steering") {
                this.#update(`message:${message.id}`, { delivery });
                this.#presentPendingSteeringAtTail();
            }
            return;
        }
        this.#appliedMessageIds.add(message.id);
        if (message.role === "system") {
            const element: SystemNoticeElement = {
                createdAt: at,
                id: `message:${message.id}`,
                kind: "system_notice",
                text: textOf(message.blocks),
                turnId: turnId ?? `history:${message.id}`,
            };
            this.#append(element);
            return;
        }
        if (message.role === "user") {
            this.#appendUserMessage(message, at, turnId, delivery);
            return;
        }
        this.#appendAgentBlocks(message, at, deltas, turnId);
    }

    #appendUserMessage(
        message: UserMessage,
        at: number,
        turnId = this.#turnId,
        delivery: UserMessageElement["delivery"] = "sent",
    ): void {
        const attachments = message.blocks
            .filter((block): block is Extract<ContentBlock, { type: "image" }> =>
                isImageBlock(block),
            )
            .map((block) => ({ data: block.data, mediaType: block.mediaType }));
        const element: UserMessageElement = {
            createdAt: at,
            delivery,
            id: `message:${message.id}`,
            kind: "user_message",
            messageId: message.id,
            text: textOf(message.blocks),
            turnId: turnId ?? `history:${message.id}`,
            ...(attachments.length === 0 ? {} : { attachments }),
        };
        this.#append(element);
    }

    /**
     * Turns a completed agent message into elements.
     *
     * Blocks already shown while streaming are reconciled rather than appended,
     * so the authoritative message replaces the live rendering without producing
     * a second copy of the same text.
     */
    #appendAgentBlocks(
        message: AgentMessage,
        at: number,
        deltas: ChatDelta[],
        turnId = this.#turnId,
    ): void {
        const elementTurnId = turnId ?? `history:${message.id}`;
        const streamed = this.#streamingMessageId === message.id;
        for (const [contentIndex, block] of message.blocks.entries()) {
            if (isTextBlock(block)) {
                const existing = streamed
                    ? this.#findStreamed("agent_text", contentIndex)
                    : undefined;
                if (existing !== undefined) {
                    this.#update(existing.id, { complete: true, text: block.text });
                    continue;
                }
                if (block.text.length === 0) continue;
                this.#append({
                    complete: true,
                    createdAt: at,
                    id: `${message.id}:agent_text:${contentIndex}`,
                    kind: "agent_text",
                    text: block.text,
                    turnId: elementTurnId,
                });
                continue;
            }
            if (isThinkingBlock(block)) {
                const existing = streamed
                    ? this.#findStreamed("thinking", contentIndex)
                    : undefined;
                if (existing !== undefined) {
                    this.#update(existing.id, { complete: true, text: block.thinking });
                    continue;
                }
                if (block.thinking.length === 0) continue;
                this.#append({
                    complete: true,
                    createdAt: at,
                    id: `${message.id}:thinking:${contentIndex}`,
                    kind: "thinking",
                    text: block.thinking,
                    turnId: elementTurnId,
                });
                continue;
            }
            if (isToolCallBlock(block)) {
                this.#upsertToolCall(block, at, elementTurnId);
                continue;
            }
            if (isToolResultBlock(block)) this.#applyToolResult(block);
        }
        if (message.usage !== undefined) {
            // A turn that calls tools runs inference more than once, so the cost
            // of the turn is the sum rather than the last message's share.
            this.#turnUsage = addUsage(this.#turnUsage, message.usage);
            deltas.push({ type: "session_changed", session: this.#session });
        }
    }

    /** Applies a later copy of a message that is already in the list. */
    #reconcileAgentMessage(message: AgentMessage, at: number): void {
        for (const block of message.blocks) {
            if (isToolCallBlock(block)) this.#upsertToolCall(block, at, this.#turnId ?? "");
            else if (isToolResultBlock(block)) this.#applyToolResult(block);
        }
    }

    /**
     * Restores the message a run is part-way through generating.
     *
     * Only a client that attached mid-turn sees this; the same content arrives as
     * deltas for a client that was already watching, so the elements are keyed
     * the same way and converge either way.
     */
    #applyPartialMessage(message: AgentMessage, runId: string, deltas: ChatDelta[]): void {
        this.#startTurn(runId, this.#session.activity.since, deltas);
        this.#streamingMessageId = message.id;
        for (const [contentIndex, block] of message.blocks.entries()) {
            if (isTextBlock(block)) {
                this.#openStreamedElement("agent_text", contentIndex, block.text, message.id);
                continue;
            }
            if (isThinkingBlock(block)) {
                this.#openStreamedElement("thinking", contentIndex, block.thinking, message.id);
                continue;
            }
            if (isToolCallBlock(block))
                this.#upsertToolCall(block, this.#session.activity.since, runId);
        }
    }

    #applyAgentEvent(event: AgentLoopEvent, at: number, deltas: ChatDelta[]): void {
        switch (event.type) {
            case "inference_iteration_start":
                this.#streamingMessageId = (event as { messageId: string }).messageId;
                this.#streamingElementIds.clear();
                return;
            case "block_reset":
                // The provider restarted the message mid-stream, so everything
                // already shown for it was tentative. It is dropped rather than
                // left for a later completed message to contradict.
                this.#discardStreamedElements();
                return;
            case "text_start":
            case "text_delta":
            case "text_end":
                this.#applyStreamedText("agent_text", event, at);
                return;
            case "thinking_start":
            case "thinking_delta":
            case "thinking_end":
                this.#applyStreamedText("thinking", event, at);
                return;
            case "toolcall_start":
            case "toolcall_delta":
            case "toolcall_end":
                this.#applyStreamedToolCall(event, at);
                return;
            case "tool_execution_start": {
                const call = (event as { toolCall: ToolCallBlock }).toolCall;
                const elementId = this.#upsertToolCall(call, at, this.#turnId ?? "");
                this.#update(elementId, { status: "running" });
                return;
            }
            case "tool_execution_progress": {
                const data = event as { display: string; toolCallId: string };
                const elementId = this.#toolCallElementIds.get(data.toolCallId);
                if (elementId !== undefined) this.#update(elementId, { progress: data.display });
                return;
            }
            case "tool_execution_status": {
                const data = event as { status: string; toolCallId: string };
                const elementId = this.#toolCallElementIds.get(data.toolCallId);
                if (elementId !== undefined) this.#update(elementId, { progress: data.status });
                return;
            }
            case "tool_execution_end": {
                const result = (event as Extract<AgentLoopEvent, { type: "tool_execution_end" }>)
                    .result;
                const elementId = this.#toolCallElementIds.get(result.toolCallId);
                if (elementId === undefined) return;
                this.#toolCallElementIds.delete(result.toolCallId);
                this.#update(elementId, {
                    argumentsComplete: true,
                    status: toolStatus(result),
                    ...(result.display === undefined ? {} : { result: result.display }),
                    ...this.#presentationUpdate(elementId, result.presentation),
                });
                return;
            }
            case "context_compaction_started": {
                const data = event as {
                    compactionId: string;
                    estimatedTokensBefore: number;
                };
                const id = this.#nextId("compaction");
                this.#compactionElementIds.set(data.compactionId, id);
                this.#append({
                    compactionId: data.compactionId,
                    createdAt: at,
                    estimatedTokensBefore: data.estimatedTokensBefore,
                    id,
                    kind: "compaction",
                    status: "running",
                    turnId: this.#turnId ?? `compaction:${data.compactionId}`,
                });
                deltas.push({ type: "compaction_started", compactionId: data.compactionId });
                return;
            }
            case "context_compacted": {
                const data = event as {
                    compactedMessageCount: number;
                    compactionId: string;
                    estimatedTokensAfter: number;
                };
                const elementId = this.#compactionElementIds.get(data.compactionId);
                if (elementId !== undefined) {
                    this.#update(elementId, {
                        estimatedTokensAfter: data.estimatedTokensAfter,
                        messagesCompacted: data.compactedMessageCount,
                    });
                }
                if (this.#session.usage?.context !== undefined) {
                    this.#session = {
                        ...this.#session,
                        usage: {
                            ...this.#session.usage,
                            context: {
                                ...this.#session.usage.context,
                                approximate: true,
                                totalTokens: data.estimatedTokensAfter,
                            },
                        },
                    };
                }
                return;
            }
            case "context_compaction_finished": {
                const data = event as {
                    compactionId: string;
                    status: "cancelled" | "completed" | "failed";
                };
                const elementId = this.#compactionElementIds.get(data.compactionId);
                this.#compactionElementIds.delete(data.compactionId);
                if (elementId !== undefined) this.#update(elementId, { status: data.status });
                deltas.push({ type: "compaction_finished", compactionId: data.compactionId });
                return;
            }
            case "background_processes_changed": {
                const processes =
                    (
                        event as {
                            processes?: readonly BackgroundProcess[];
                        }
                    ).processes ?? [];
                this.#session = { ...this.#session, backgroundProcesses: processes };
                return;
            }
            case "permission_review": {
                const review = event as PermissionReviewState & {
                    transcript?: { modelId: string; providerId: string; usage: Usage };
                    type: "permission_review";
                };
                const next: PermissionReviewState = {
                    action: review.action,
                    decision: review.decision,
                    reason: review.reason,
                    risk: review.risk,
                    toolCallId: review.toolCallId,
                    userAuthorization: review.userAuthorization,
                };
                const elementId = this.#toolCallElementIds.get(next.toolCallId);
                if (elementId !== undefined) {
                    this.#update(elementId, { permissionReview: next });
                }
                if (review.transcript !== undefined) {
                    this.#recordUsageGroup({
                        kind: "attributed",
                        modelId: review.transcript.modelId,
                        providerId: review.transcript.providerId,
                        requestedModelId: review.transcript.modelId,
                        role: "permission_review",
                        usage: review.transcript.usage,
                    });
                }
                this.#session = {
                    ...this.#session,
                    permissionReviews: [
                        ...this.#session.permissionReviews.filter(
                            (known) => known.toolCallId !== next.toolCallId,
                        ),
                        next,
                    ].slice(-100),
                };
                return;
            }
            default:
        }
    }

    /** Drops the tentative elements of the message currently being streamed. */
    #discardStreamedElements(): void {
        for (const elementId of this.#streamingElementIds.values()) {
            const element = this.#byId.get(elementId);
            if (element?.kind === "tool_call" && element.toolCallId.length > 0) {
                this.#toolCallElementIds.delete(element.toolCallId);
            }
            this.#remove(elementId);
        }
        this.#streamingElementIds.clear();
    }

    #applyStreamedText(kind: "agent_text" | "thinking", event: AgentLoopEvent, at: number): void {
        const data = event as {
            content?: string;
            contentIndex: number;
            delta?: string;
            messageId?: string;
        };
        const key = streamKey(kind, data.contentIndex);
        const existingId = this.#streamingElementIds.get(key);
        if (existingId === undefined) {
            const id = `${data.messageId ?? this.#streamingMessageId ?? "stream"}:${kind}:${data.contentIndex}`;
            this.#streamingElementIds.set(key, id);
            this.#append({
                complete: false,
                createdAt: at,
                id,
                kind,
                text: data.delta ?? data.content ?? "",
                turnId: this.#turnId ?? "",
            } as AgentTextElement | ThinkingElement);
            return;
        }
        const existing = this.#byId.get(existingId);
        if (
            existing === undefined ||
            (existing.kind !== "agent_text" && existing.kind !== "thinking")
        ) {
            return;
        }
        if (data.content !== undefined) {
            this.#update(existingId, { complete: true, text: data.content });
            return;
        }
        if (data.delta !== undefined) {
            this.#update(existingId, { text: existing.text + data.delta });
        }
    }

    #applyStreamedToolCall(event: AgentLoopEvent, at: number): void {
        const data = event as {
            contentIndex: number;
            delta?: string;
            messageId?: string;
            toolCall?: { arguments?: unknown; id: string; name: string };
        };
        const key = streamKey("tool_call", data.contentIndex);
        const existingId = this.#streamingElementIds.get(key);
        if (data.toolCall !== undefined) {
            // The finished call carries its real identity, so the placeholder is
            // replaced by an element keyed on the daemon's tool-call id.
            if (existingId !== undefined) this.#remove(existingId);
            this.#streamingElementIds.delete(key);
            this.#upsertToolCall(
                {
                    arguments: data.toolCall.arguments,
                    id: data.toolCall.id,
                    name: data.toolCall.name,
                    type: "tool_call",
                },
                at,
                this.#turnId ?? "",
            );
            return;
        }
        if (existingId !== undefined) return;
        const id = `${data.messageId ?? this.#streamingMessageId ?? "stream"}:tool:${data.contentIndex}`;
        this.#streamingElementIds.set(key, id);
        this.#append({
            arguments: undefined,
            argumentsComplete: false,
            createdAt: at,
            id,
            kind: "tool_call",
            name: "",
            status: "pending",
            toolCallId: "",
            turnId: this.#turnId ?? "",
        });
    }

    /** Adds a tool call, or fills in the one already shown for the same call. */
    #upsertToolCall(block: ToolCallBlock, at: number, turnId: string): string {
        const existingId = this.#toolCallElementIds.get(block.id);
        if (existingId !== undefined) {
            if (block.presentation !== undefined) {
                this.#callPresentations.set(existingId, block.presentation);
            }
            this.#update(existingId, {
                argumentsComplete: true,
                arguments: block.arguments,
                name: block.name,
                ...presentationOf(projectToolPresentation(block.presentation, undefined)),
            });
            return existingId;
        }
        const id = `tool:${block.id}`;
        this.#toolCallElementIds.set(block.id, id);
        if (block.presentation !== undefined) this.#callPresentations.set(id, block.presentation);
        const element: ToolCallElement = {
            argumentsComplete: true,
            arguments: block.arguments,
            createdAt: at,
            id,
            kind: "tool_call",
            name: block.name,
            status: "pending",
            toolCallId: block.id,
            turnId,
            ...presentationOf(projectToolPresentation(block.presentation, undefined)),
        };
        this.#append(element);
        return id;
    }

    #applyToolResult(block: ToolResultBlock): void {
        const elementId =
            this.#toolCallElementIds.get(block.toolCallId) ?? `tool:${block.toolCallId}`;
        if (this.#byId.get(elementId) === undefined) return;
        this.#toolCallElementIds.delete(block.toolCallId);
        this.#update(elementId, {
            argumentsComplete: true,
            result: block.display,
            status: toolStatus(block),
            ...this.#presentationUpdate(elementId, block.presentation),
        });
    }

    /**
     * Projects a finished call, pairing the result with the call it belongs to.
     *
     * The raw call presentation is released here: once the result is known the
     * pair has been projected and keeping the earlier half would retain one
     * entry per tool call for the life of the session.
     */
    #presentationUpdate(
        elementId: string,
        result: ToolResultPresentation | undefined,
    ): { presentation?: ToolPresentation } {
        const call = this.#callPresentations.get(elementId);
        this.#callPresentations.delete(elementId);
        return presentationOf(projectToolPresentation(call, result));
    }

    #findStreamed(kind: "agent_text" | "thinking", index: number): ChatElement | undefined {
        const id = this.#streamingElementIds.get(streamKey(kind, index));
        return id === undefined ? undefined : this.#byId.get(id);
    }

    #openStreamedElement(
        kind: "agent_text" | "thinking",
        index: number,
        text: string,
        messageId: string,
    ): void {
        const id = `${messageId}:${kind}:${index}`;
        this.#streamingElementIds.set(streamKey(kind, index), id);
        if (this.#byId.has(id)) {
            this.#update(id, { text });
            return;
        }
        this.#append({
            complete: false,
            createdAt: this.#session.activity.since,
            id,
            kind,
            text,
            turnId: this.#turnId ?? "",
        } as AgentTextElement | ThinkingElement);
    }

    #append(element: ChatElement): void {
        if (this.#byId.has(element.id)) {
            this.#update(element.id, element as Partial<ChatElement>);
            return;
        }
        const kept = this.#priorElements?.get(element.id);
        if (kept !== undefined && isSameElement(kept, element)) {
            // A rebuild reproduces rows the list already had. Handing back the
            // object a consumer is already holding keeps a reader's scroll
            // anchor and spares React the re-render.
            element = kept;
        }
        this.#byId.set(element.id, element);
        this.#chronologicalElementIds.push(element.id);
        this.#indexById.set(element.id, this.#elements.length);
        this.#elements = [...this.#elements, element];
        this.#revision += 1;
        this.#presentPendingSteeringAtTail();
        // Only a tool call can change how calls are grouped.
        if (element.kind === "tool_call") this.#groupingDirty = true;
    }

    /**
     * Replaces one element with an updated copy.
     *
     * Only that element gets a new reference; every other element in the new
     * array is the same object the consumer already rendered. The position is
     * looked up rather than searched, so the cost of a streaming delta does not
     * grow with the length of the conversation.
     */
    #update(id: string, changes: Partial<ChatElement>): void {
        const existing = this.#byId.get(id);
        if (existing === undefined) return;
        const updated = { ...existing, ...changes } as ChatElement;
        if (isUnchanged(existing, updated)) return;
        const index = this.#indexById.get(id);
        if (index === undefined) return;
        this.#byId.set(id, updated);
        const next = this.#elements.slice();
        next[index] = updated;
        this.#elements = next;
        this.#revision += 1;
        if (updated.kind === "tool_call" && updated.turnId !== existing.turnId) {
            this.#groupingDirty = true;
        }
    }

    #remove(id: string): void {
        if (!this.#byId.has(id)) return;
        const removed = this.#byId.get(id);
        this.#byId.delete(id);
        this.#indexById.delete(id);
        this.#chronologicalElementIds = this.#chronologicalElementIds.filter(
            (elementId) => elementId !== id,
        );
        this.#elements = this.#elements.filter((element) => element.id !== id);
        this.#reindex();
        this.#revision += 1;
        if (removed?.kind === "tool_call") this.#groupingDirty = true;
    }

    /**
     * Presents queued steering as ordinary bubbles pinned after all live work.
     *
     * `#chronologicalElementIds` never changes when a bubble is pinned, so
     * accepting it can restore the authoritative event position using the same
     * element object and id.
     */
    #presentPendingSteeringAtTail(): void {
        const pendingIds = this.#session.pendingSteeringMessages
            .map((pending) => `message:${pending.message.id}`)
            .filter((id) => this.#byId.get(id)?.kind === "user_message");
        const pending = new Set(pendingIds);
        const orderedIds = [
            ...this.#chronologicalElementIds.filter((id) => this.#byId.has(id) && !pending.has(id)),
            ...pendingIds,
        ];
        if (
            orderedIds.length === this.#elements.length &&
            orderedIds.every((id, index) => this.#elements[index]?.id === id)
        ) {
            return;
        }
        this.#elements = orderedIds.flatMap((id) => {
            const element = this.#byId.get(id);
            return element === undefined ? [] : [element];
        });
        this.#reindex();
        this.#revision += 1;
    }

    /** Rebuilds the position index after the list order or length changed. */
    #reindex(): void {
        this.#indexById.clear();
        for (const [index, element] of this.#elements.entries()) {
            this.#indexById.set(element.id, index);
        }
    }

    #nextId(prefix: string): string {
        this.#sequence += 1;
        return `${prefix}:${this.#session.sessionId}:${this.#sequence}`;
    }
}

function streamKey(kind: string, index: number): number {
    // One map holds text, thinking, and tool-call blocks, which are indexed
    // independently by the provider, so the kind has to be part of the key.
    const offset = kind === "agent_text" ? 0 : kind === "thinking" ? 1_000_000 : 2_000_000;
    return offset + index;
}

function toolStatus(result: {
    failure?: { kind: string };
    isError?: boolean;
}): ToolCallElement["status"] {
    if (result.failure?.kind === "interrupted") return "interrupted";
    return result.isError === true || result.failure !== undefined ? "failed" : "succeeded";
}

function isUnchanged(left: ChatElement, right: ChatElement): boolean {
    const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
    for (const key of keys) {
        const leftValue = (left as unknown as Record<string, unknown>)[key];
        const rightValue = (right as unknown as Record<string, unknown>)[key];
        if (leftValue !== rightValue) return false;
    }
    return true;
}

function textOf(blocks: readonly ContentBlock[]): string {
    return blocks
        .filter(isTextBlock)
        .map((block) => block.text)
        .join("");
}

function isTextBlock(
    block: ContentBlock | AgentBlock,
): block is Extract<ContentBlock, { type: "text" }> {
    return block.type === "text";
}

function isImageBlock(block: ContentBlock): block is Extract<ContentBlock, { type: "image" }> {
    return block.type === "image";
}

function isThinkingBlock(block: AgentBlock): block is Extract<AgentBlock, { type: "thinking" }> {
    return block.type === "thinking";
}

function isToolCallBlock(block: AgentBlock): block is ToolCallBlock {
    return block.type === "tool_call";
}

function isToolResultBlock(block: AgentBlock): block is ToolResultBlock {
    return block.type === "tool_result";
}

/** Sums the cost of two inferences in one turn. */
function addUsage(total: Usage | undefined, next: Usage): Usage {
    if (total === undefined) return next;
    return {
        cacheRead: total.cacheRead + next.cacheRead,
        cacheWrite: total.cacheWrite + next.cacheWrite,
        cost: {
            cacheRead: total.cost.cacheRead + next.cost.cacheRead,
            cacheWrite: total.cost.cacheWrite + next.cost.cacheWrite,
            input: total.cost.input + next.cost.input,
            output: total.cost.output + next.cost.output,
            total: total.cost.total + next.cost.total,
        },
        input: total.input + next.input,
        output: total.output + next.output,
        totalTokens: total.totalTokens + next.totalTokens,
        ...(total.reasoning === undefined && next.reasoning === undefined
            ? {}
            : { reasoning: (total.reasoning ?? 0) + (next.reasoning ?? 0) }),
    };
}

function applicationUsage(snapshot: SessionUsageSnapshot): SessionUsage {
    return {
        ...snapshot,
        totalCost: snapshot.groups.reduce((total, group) => total + group.usage.cost.total, 0),
        totalTokens: snapshot.groups.reduce((total, group) => total + group.usage.totalTokens, 0),
    };
}

function historyToken(transcript: SessionTranscriptWindow): string | undefined {
    return transcript.messages[0]?.id;
}

function withoutUsageContext(usage: SessionUsage): SessionUsage {
    const { context: _context, ...withoutContext } = usage;
    return withoutContext;
}

function applicationGit(git: GitChangeSnapshot): GitChangeSnapshot {
    return {
        ...git,
        revision: `${git.generation}:${String(git.version)}:${String(git.scannedAt)}`,
    };
}

/** Omits the key entirely when there is nothing to present. */
function presentationOf(presentation: ToolPresentation | undefined): {
    presentation?: ToolPresentation;
} {
    return presentation === undefined ? {} : { presentation };
}

/**
 * Copies a session state without the named keys.
 *
 * `exactOptionalPropertyTypes` forbids assigning `undefined` to an optional
 * field, so a value that was cleared has to be dropped rather than blanked.
 */
function withoutKeys(session: SessionState, keys: readonly (keyof SessionState)[]): SessionState {
    const next = { ...session };
    for (const key of keys) delete next[key];
    return next;
}

/**
 * Whether a rebuilt element says exactly what the one before it said.
 *
 * These are plain value objects built by one code path, so a serialised
 * comparison is both accurate and cheaper than walking them field by field.
 */
function isSameElement(left: ChatElement, right: ChatElement): boolean {
    return left === right || JSON.stringify(left) === JSON.stringify(right);
}
