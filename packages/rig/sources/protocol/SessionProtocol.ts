import type {
    AgentCompactionResult,
    AgentLoopEvent,
    AgentSnapshot,
    ContentBlock,
} from "../agent/index.js";
import type { AgentMessage, Message, UserMessage } from "../agent/types.js";
import type { Model, ServiceTier, StopReason, Usage } from "@slopus/rig-execution";
import type { ProviderModelCompatibilityType, ProviderQuota } from "@slopus/rig-providers";
import type { PermissionMode } from "../permissions/index.js";
import type { UserInputRequest, UserInputResponse } from "../user-input/index.js";
import type { McpServerSummary } from "../mcp/index.js";
import type { SessionTask } from "../tasks/index.js";
import type { WorkflowRun, WorkflowRunUpdate } from "../workflows/index.js";
import type { ChangeGoalStatusRequest, CreateGoalRequest, SessionGoal } from "../goals/index.js";
import type { EventId } from "./EventId.js";
import type { GitChangeSnapshot } from "./ProjectProtocol.js";
import type { DockerExecutionConfig } from "../execution/DockerExecutionConfig.js";
import type { SessionExecutionEnvironment } from "../execution/SessionExecutionEnvironment.js";
import type { BashSessionActivity, BashSessionSnapshot } from "../agent/context/BashContext.js";
import type {
    SecretAttachmentScope,
    SecretReference,
    SecretRegistration,
} from "../secrets/index.js";
import type {
    ExternalToolCall,
    ExternalToolCallResolution,
    ExternalToolDefinition,
    ResolveExternalToolCallResponse,
} from "../external-tools/index.js";
import type { DurableSkillDefinition } from "../external-skills/index.js";

export type SessionStatus =
    | "idle"
    | "queued"
    | "running"
    | "completed"
    | "aborted"
    | "suspended"
    | "error"
    | "archived";

export type SessionSummaryStatus = SessionStatus;

/**
 * What a session is doing at this moment.
 *
 * `SessionStatus` answers whether a session is busy; this answers what the busy
 * work is, so a client can render a status line without replaying the event log
 * and tracking which streaming blocks are still open.
 */
export type SessionActivityKind =
    | "idle"
    | "queued"
    | "thinking"
    | "generating_message"
    | "generating_tool_call"
    | "executing_tool_call"
    | "awaiting_input"
    | "compacting"
    | "retrying"
    | "stopped"
    | "error";

export interface SessionActivityToolCall {
    startedAt: number;
    /** Latest short label the tool reported about its own progress. */
    status?: string;
    toolCallId: string;
    toolName: string;
}

export interface SessionActivityCompaction {
    compactionId: string;
    estimatedTokensBefore: number;
    reason: "context_window" | "manual" | "threshold";
    startedAt: number;
}

export interface SessionActivityRetry {
    attempt: number;
    reason: string;
}

export interface SessionActivity {
    /** Ready-to-display description of the current work, such as `Running Bash`. */
    label: string;
    kind: SessionActivityKind;
    runId?: string;
    /** When the session entered this activity, in milliseconds since the epoch. */
    since: number;
    compaction?: SessionActivityCompaction;
    /** Requests the session is blocked on, including permission approvals. */
    pendingInputRequestIds?: readonly string[];
    retry?: SessionActivityRetry;
    /** Tool calls that have started and not yet reported a result. */
    toolCalls?: readonly SessionActivityToolCall[];
}

export type SessionUnreadReason = "attention_needed" | "turn_finished";

export interface SessionTokenCount {
    lastContextTokens: number;
    totalTokens: number;
}

export interface SessionUnreadState {
    reason: SessionUnreadReason;
    since: number;
}

export type SessionTitleStatus = "idle" | "generating" | "ready" | "error";

export type { SessionExecutionEnvironment } from "../execution/SessionExecutionEnvironment.js";

export type SessionInterruptionReason = "crash" | "shutdown";

export type SessionAgentType = "primary" | "subagent";

export interface SessionAgentMetadata {
    depth: number;
    rootSessionId: string;
    type: SessionAgentType;
    description?: string;
    parentSessionId?: string;
    parentToolCallId?: string;
    taskName?: string;
}

export interface SessionInterruption {
    interruptedAt: number;
    message: string;
    reason: SessionInterruptionReason;
    runId?: string;
}

export interface ProviderModelCatalog {
    disabledReason?: "not_authenticated" | "not_enabled" | "no_models";
    providerId: string;
    providerType?: ProviderModelCompatibilityType;
    models: readonly Model[];
    serviceTiers?: readonly ServiceTier[];
}

export interface ModelCatalog {
    defaultModelId: string;
    defaultProviderId: string;
    models: readonly Model[];
    providers: readonly ProviderModelCatalog[];
}

export interface DaemonIdentity {
    version: string;
    developmentBuildId?: string;
}

export interface ReadyHealthResponse {
    catalog: ModelCatalog;
    durableGlobalEventQueue: boolean;
    healthy: true;
    identity: DaemonIdentity;
    ready: true;
    status: "ready";
}

export interface StartingHealthResponse {
    healthy: true;
    identity: DaemonIdentity;
    ready: false;
    status: "starting";
}

export interface ErrorHealthResponse {
    error: string;
    healthy: false;
    identity: DaemonIdentity;
    ready: false;
    status: "error";
}

export type HealthResponse = ErrorHealthResponse | ReadyHealthResponse | StartingHealthResponse;

export interface ListModelsResponse {
    catalog: ModelCatalog;
}

export interface DaemonConfig {
    settings: {
        durableGlobalEventQueue: boolean;
    };
}

export interface GetDaemonConfigResponse {
    config: DaemonConfig;
}

export interface UpdateDaemonConfigRequest {
    settings: {
        durableGlobalEventQueue: boolean;
    };
}

export type UpdateDaemonConfigResponse = GetDaemonConfigResponse;

export interface PendingSteeringMessage {
    createdAt: number;
    message: UserMessage;
    runId: string;
}

/** The turn currently occupying the session, timed from its original submission. */
export interface SessionActiveTurn {
    runId: string;
    startedAt: number;
}

export interface SessionPermissionReview {
    action: string;
    decision: "allow" | "deny";
    reason: string;
    risk: "low" | "medium" | "high" | "critical";
    toolCallId: string;
    userAuthorization: "unknown" | "low" | "medium" | "high";
}

export interface ProtocolSession {
    id: string;
    /** What the session is doing at this moment. */
    activity: SessionActivity;
    activeTurn?: SessionActiveTurn;
    agentId: string;
    /** Git state of the session's directory, when it is inside a repository. */
    git?: GitChangeSnapshot;
    archived: boolean;
    projectId: string;
    workspaceId?: string;
    archiveOnIdle?: boolean;
    trackUnread?: boolean;
    unread?: SessionUnreadState;
    appendSystemPrompt?: string;
    cwd: string;
    draft?: string;
    draftUpdatedAt?: number;
    providerId: string;
    permissionMode: PermissionMode;
    modelId: string;
    orderKey: string;
    effort?: string;
    serviceTier?: ServiceTier;
    secretIds: readonly string[];
    projectSecretIds: readonly string[];
    sessionSecretIds: readonly string[];
    environment?: SessionExecutionEnvironment;
    modelLocked: boolean;
    models: readonly Model[];
    status: SessionStatus;
    title?: string;
    titleError?: string;
    titleStatus: SessionTitleStatus;
    recap?: string;
    metadataUpdatedAt?: number;
    metadataRunId?: string;
    interruption?: SessionInterruption;
    lastEventId?: EventId;
    agent: SessionAgentMetadata;
    snapshot: AgentSnapshot;
    pendingUserInputs: readonly UserInputRequest[];
    permissionReviews?: readonly SessionPermissionReview[];
    pendingSteeringMessages?: readonly PendingSteeringMessage[];
    subagents?: readonly SubagentSummary[];
    shellCommands?: readonly ShellCommandState[];
    mcpServers: readonly McpServerSummary[];
    tasks: readonly SessionTask[];
    workflowsEnabled?: boolean;
    workflows?: readonly WorkflowRun[];
    goal?: SessionGoal;
    backgroundProcesses?: readonly BashSessionActivity[];
    cumulativeUsage?: Usage;
    sessionTokenCount?: SessionTokenCount;
    externalTools?: readonly ExternalToolDefinition[];
    skills?: readonly DurableSkillDefinition[];
    pendingExternalToolCalls?: readonly ExternalToolCall[];
    systemPrompt?: string;
}

/**
 * An assistant message the model is still producing.
 *
 * Committed transcripts never contain it, so without this a client that attaches
 * mid-turn shows nothing until the message completes.
 */
export interface SessionPartialMessage {
    message: AgentMessage;
    runId: string;
}

/**
 * One turn of the transcript carried in a stream's opening frame.
 *
 * The messages alone do not say where a turn began, how it ended, or how long it
 * took, so a client given only messages has to guess. This states it, which is
 * what lets a client honour the guarantee that every turn ends in a final
 * element even for history it never watched happen.
 */
export interface SessionTranscriptTurn {
    /** Identifies the run, and is the turn identity a client renders against. */
    runId: string;
    /** Messages belonging to this turn, in order, by id. */
    messageIds: readonly string[];
    startedAt: number;
    /** Absent while the turn is still running. */
    endedAt?: number;
    /** Absent while the turn is still running. */
    outcome?: "success" | "error" | "stopped";
    errorMessage?: string;
    retries?: readonly SessionTranscriptRetry[];
}

export interface SessionTranscriptRetry {
    id: EventId;
    createdAt: number;
    attempt: number;
    reason: string;
}

/**
 * The transcript window carried in a stream's opening frame.
 *
 * The window is measured in whole turns, never in messages. A turn is the unit a
 * conversation is read in, and half a turn is not a smaller answer but a broken
 * one: a tool result whose call was cut away renders as an orphan.
 */
export interface SessionTranscriptWindow {
    messages: readonly Message[];
    /** Durable occurrence time of each retained message, keyed by message ID. */
    messageCreatedAt?: Readonly<Record<string, number>>;
    /** Durable event order for messages sharing the same millisecond. */
    messageEventId?: Readonly<Record<string, EventId>>;
    /** Resolved permission facts for tool calls contained in this page. */
    permissionReviews?: readonly SessionPermissionReview[];
    turns: readonly SessionTranscriptTurn[];
    /** False when the conversation began before the first turn in this window. */
    complete: boolean;
}

/**
 * The first frame of a session event stream.
 *
 * It exists so attaching is a single request. A client connecting without a
 * cursor gets the session here and never issues a follow-up call; a client
 * resuming already has the transcript and gets back only the state that cannot
 * be replayed from the durable log.
 */
export interface SessionStreamHello {
    activity: SessionActivity;
    /**
     * Current facts whose intermediate events are intentionally not retained.
     * Present on resume after durable catch-up has been delivered.
     */
    current?: SessionStreamCurrentState;
    /** Complete session usage at the hello cursor; later durable events update it. */
    usage?: GetSessionUsageResponse;
    /**
     * Present only when the client attached without a cursor. Its transcript
     * holds the most recent `SESSION_STREAM_TURN_LIMIT` complete turns, so the
     * cost of attaching is bounded by recent activity rather than by the age of
     * the session.
     */
    session?: ProtocolSession;
    /** Turn boundaries and outcomes for the transcript in `session`. */
    transcript?: SessionTranscriptWindow;
    /** The assistant message currently being generated, when a run is mid-message. */
    partial?: SessionPartialMessage;
    /** The newest event id at the moment the stream opened. */
    lastEventId?: EventId;
    /** True when the client attached with a cursor and is resuming. */
    resumed: boolean;
}

export interface SessionStreamCurrentState {
    draft?: string;
    draftUpdatedAt?: number;
    git?: GitChangeSnapshot;
    sessionTokenCount?: SessionTokenCount;
}

/**
 * How many recent turns the stream's opening frame carries.
 *
 * A turn is delivered whole or not at all, so this bounds the window without
 * ever splitting one. The number of messages behind it varies: a turn may be a
 * single reply or a long run of tool calls, and both arrive intact.
 *
 * The snapshot already reflects every event up to `lastEventId`, so a client
 * that attaches without a cursor receives this window and nothing else; the
 * event log is never replayed on top of it.
 */
export const SESSION_STREAM_TURN_LIMIT = 20;

export interface SubagentSummary {
    activeSince?: number;
    agentId: string;
    createdAt: number;
    depth: number;
    description: string;
    elapsedMs?: number;
    id: string;
    latestText?: string;
    modelId: string;
    parentSessionId: string;
    parentToolCallId?: string;
    prompt?: string;
    status: SessionStatus;
    taskName?: string;
    totalTokens?: number;
    sessionTokenCount?: SessionTokenCount;
    updatedAt: number;
    usage?: Usage;
}

export interface SessionSummary {
    id: string;
    archived: boolean;
    projectId: string;
    workspaceId?: string;
    archiveOnIdle?: boolean;
    trackUnread?: boolean;
    unread?: SessionUnreadState;
    cwd: string;
    draft?: string;
    draftUpdatedAt?: number;
    providerId: string;
    modelId: string;
    orderKey: string;
    permissionMode: PermissionMode;
    effort?: string;
    serviceTier?: ServiceTier;
    environment?: SessionExecutionEnvironment;
    status: SessionSummaryStatus;
    title?: string;
    titleError?: string;
    titleStatus: SessionTitleStatus;
    recap?: string;
    sessionTokenCount?: SessionTokenCount;
    metadataUpdatedAt?: number;
    metadataRunId?: string;
    createdAt: number;
    updatedAt: number;
    lastMessageAt?: number;
    /** Ordered identity of the newest session mutation/state event. */
    lastEventId?: EventId;
    interruption?: SessionInterruption;
}

export interface CreateSessionRequest {
    apiKey?: string;
    appendSystemPrompt?: string;
    archiveOnIdle?: boolean;
    trackUnread?: boolean;
    cwd: string;
    effort?: string;
    serviceTier?: ServiceTier;
    instructions?: string;
    modelId?: string;
    providerId?: string;
    permissionMode?: PermissionMode;
    secretIds?: readonly string[];
    workflowsEnabled?: boolean;
    docker?: DockerExecutionConfig;
    local?: boolean;
    workspaceId?: string;
}

export interface UpdateSessionRequest {
    appendSystemPrompt: string | null;
}

export interface ChangePermissionModeRequest {
    permissionMode: PermissionMode;
}

/**
 * Longest composer draft the daemon stores and mirrors. Drafts are held in one
 * session row and broadcast on every change, so they need an explicit bound.
 */
export const SESSION_DRAFT_MAX_LENGTH = 100_000;

/**
 * How far a client's draft timestamp may trail the daemon's clock before it is
 * treated as that old rather than older still.
 */
export const SESSION_DRAFT_MAX_CLOCK_SKEW_MS = 300_000;

export interface SetSessionDraftRequest {
    /** Draft text, or `null` to clear the draft. */
    draft: string | null;
    /** Identifies the writing client so it can ignore its own echo. */
    origin?: string;
    /**
     * When the user typed this draft, in milliseconds since the epoch. The
     * daemon keeps the newest draft, so a write created before the one already
     * stored is discarded even if it arrives later. Omitting it means now.
     */
    updatedAt?: number;
}

export interface AttachSecretRequest {
    secretId: string;
    scope?: SecretAttachmentScope;
}

export interface SecretSessionResponse {
    session: ProtocolSession;
}

export type RegisterSecretRequest = SecretRegistration;
export type SecretSummary = SecretReference;

export interface ListSecretsResponse {
    secrets: readonly SecretSummary[];
}

export interface RegisterSecretResponse {
    secret: SecretSummary;
}

export interface UnregisterSecretResponse {
    removed: boolean;
}

export type SetGoalRequest = CreateGoalRequest;

export type ChangeSessionGoalStatusRequest = ChangeGoalStatusRequest;

export interface GoalSessionResponse {
    session: ProtocolSession;
}

export type AnswerUserInputRequest = UserInputResponse;

export interface CreateSessionResponse {
    session: ProtocolSession;
}

export interface ForkSessionResponse {
    session: ProtocolSession;
}

export interface RewindSessionRequest {
    messageId: string;
}

export interface RewindSessionResponse {
    message: UserMessage;
    session: ProtocolSession;
}

export interface CompactSessionResponse {
    result: AgentCompactionResult;
    session: ProtocolSession;
}

export interface ListSessionsResponse {
    sessions: readonly SessionSummary[];
}

export type ListSessionsArchivedFilter = boolean | "all";

export interface ListSessionsOptions {
    archived?: ListSessionsArchivedFilter;
    limit?: number;
}

export interface SessionArchiveResponse {
    session: ProtocolSession;
}

export interface ListSubagentsResponse {
    subagents: readonly SubagentSummary[];
}

export interface SessionUsageGroup {
    kind: "attributed";
    modelId: string;
    providerId: string;
    requestedModelId: string;
    /** Set when these tokens were spent reviewing permissions rather than answering the user. */
    role?: "permission_review";
    usage: Usage;
    responseModel?: string;
}

export interface SessionContextUsage {
    approximate: boolean;
    modelId: string;
    providerId: string;
    requestedModelId: string;
    responseModel?: string;
    totalTokens: number;
}

export interface GetSessionUsageResponse {
    currentProviderId: string;
    groups: readonly SessionUsageGroup[];
    context?: SessionContextUsage;
    observedQuota: readonly SessionQuotaContribution[];
    quotas: readonly SessionProviderQuota[];
    sessionTokenCount: SessionTokenCount;
}

export interface GetCurrentProviderQuotaResponse {
    currentProviderId: string;
    quota?: ProviderQuota;
}

export interface SessionProviderQuota {
    providerId: string;
    quota: ProviderQuota;
}

export interface SessionQuotaContribution {
    providerId: string;
    windows: {
        fiveHour?: SessionQuotaWindowContribution;
        weekly?: SessionQuotaWindowContribution;
    };
}

export interface SessionQuotaWindowContribution {
    observedUsedPercent: number;
}

export interface StopWorkflowResponse {
    workflow: WorkflowRun;
}

export interface FileSearchResult {
    fileName: string;
    path: string;
}

export interface SearchFilesResponse {
    files: readonly FileSearchResult[];
}

export interface ShutdownServerResponse {
    pid?: number;
    shuttingDown: boolean;
}

export interface StartInspectorResponse {
    inspectorUrl: string;
}

export interface ListExternalToolCallsResponse {
    calls: readonly ExternalToolCall[];
}

export interface SubmitMessageRequest {
    clientSubmissionId?: string;
    content?: readonly ContentBlock[];
    debug?: boolean;
    displayText?: string;
    interactive?: boolean;
    /** Replaces the external function set for this and subsequent runs when present. */
    externalTools?: readonly ExternalToolDefinition[];
    /** Replaces the integration-owned durable skill set when present. */
    skills?: readonly DurableSkillDefinition[];
    /** Replaces Rig's assembled system prompt. Null restores Rig's normal prompt. */
    systemPrompt?: string | null;
    /**
     * Reasoning effort for this and subsequent runs. Applied when this message's run starts, so
     * it never disturbs a run already in progress.
     */
    effort?: string;
    /** Model for this and subsequent runs. Applied when this message's run starts. */
    modelId?: string;
    /** Provider for `modelId`. Inferred from the model when omitted. */
    providerId?: string;
    /**
     * Fast mode for this and subsequent runs. Null turns it off; omitting it changes nothing.
     * Applied when this message's run starts.
     */
    serviceTier?: ServiceTier | null;
    text: string;
    /** Identity used to correlate the optimistic action with its stream echo. */
    mutationId?: string;
}

export interface BroadcastMessageRequest extends SubmitMessageRequest {
    all?: boolean;
    sessionIds?: readonly string[];
}

export interface BroadcastMessageResponse {
    submissions: readonly SubmitMessageResponse[];
}

export type ResolveExternalToolCallRequest = ExternalToolCallResolution;
export type { ResolveExternalToolCallResponse };

export interface SubmitMessageResponse {
    debugDirectory?: string;
    eventId: EventId;
    runId: string;
    sessionId: string;
}

export interface RecordSessionActivityResponse {
    recorded: true;
}

export interface SessionTerminalHeartbeatRequest {
    connectionId: string;
    focused: boolean;
    targetPid: number;
}

export interface SessionTerminalHeartbeatResponse {
    connected: true;
}

export interface DisconnectSessionTerminalResponse {
    disconnected: boolean;
}

export interface RunShellCommandRequest {
    command: string;
    commandId: string;
}

export interface RunShellCommandResult {
    command: string;
    commandId: string;
    errorMessage?: string;
    exitCode: number | null;
    output: string;
    sessionId?: number;
    timedOut: boolean;
}

export type ShellCommandState =
    | {
          command: string;
          commandId: string;
          sessionId: number;
          status: "running";
      }
    | (RunShellCommandResult & { status: "finished" });

export interface RunningShellCommandResponse {
    command: string;
    commandId: string;
    eventId: EventId;
    sessionId: number;
    status: "running";
}

export type RunShellCommandResponse =
    | RunningShellCommandResponse
    | (RunShellCommandResult & { eventId: EventId; status: "finished" });

export type ReadBackgroundProcessResponse = BashSessionSnapshot;

export interface StopBackgroundProcessResponse {
    process?: BashSessionSnapshot;
    stopped: boolean;
}

export interface SteerMessageRequest extends SubmitMessageRequest {
    clientSubmissionId?: string;
    expectedRunId?: string;
}
export interface SteerMessageResponse extends SubmitMessageResponse {
    delivery: "run" | "steer";
}

export interface ChangeModelRequest {
    effort?: string;
    modelId: string;
    providerId?: string;
    mutationId?: string;
}

export interface ChangeEffortRequest {
    effort?: string;
}

export interface ChangeServiceTierRequest {
    serviceTier?: ServiceTier;
}

export interface AbortRunResponse {
    aborted: boolean;
    continued?: boolean;
    eventId?: EventId;
    stoppedProcesses?: number;
}

export interface AbortRunOptions {
    continuePendingSteering?: boolean;
    expectedRunId?: string;
    steeringMessageIds?: readonly string[];
    mutationId?: string;
}

export type SessionEvent =
    | SessionCreatedEvent
    | SessionUpdatedEvent
    | SessionArchiveChangedEvent
    | SessionWorkspaceArchivedEvent
    | MessageSubmittedEvent
    | SteeringAppliedEvent
    | RunStartedEvent
    | InferenceRetryEvent
    | AgentStreamEvent
    | AgentMessageEvent
    | RunFinishedEvent
    | ProviderQuotaObservedEvent
    | SessionQuotaContributionChangedEvent
    | RunErrorEvent
    | AbortRequestedEvent
    | SessionResetEvent
    | SessionRewoundEvent
    | SessionStatusChangedEvent
    | SessionTitleChangedEvent
    | SessionActivityChangedEvent
    | SessionContextChangedEvent
    | SessionGitChangedEvent
    | SessionConfigurationChangedEvent
    | PermissionModeChangedEvent
    | SessionDraftChangedEvent
    | SecretsChangedEvent
    | UserInputRequestedEvent
    | UserInputResolvedEvent
    | McpServersChangedEvent
    | TasksChangedEvent
    | GoalChangedEvent
    | SubagentChangedEvent
    | SubagentsSuspendedEvent
    | WorkflowChangedEvent
    | ExternalToolCallRequestedEvent
    | ExternalToolCallResolvedEvent
    | ShellCommandStartedEvent
    | ShellCommandFinishedEvent;

export interface BaseSessionEvent<TType extends string, TData> {
    createdAt: number;
    data: TData;
    id: EventId;
    sessionId: string;
    type: TType;
}

export type SessionCreatedEvent = BaseSessionEvent<"session_created", { session: ProtocolSession }>;

export type SessionUpdatedEvent = BaseSessionEvent<"session_updated", { session: ProtocolSession }>;

export type SessionArchiveChangedEvent = BaseSessionEvent<
    "session_archived",
    { archived: boolean; mutationId?: string }
>;

export type SessionWorkspaceArchivedEvent = BaseSessionEvent<
    "session_workspace_archived",
    { reason: "workspace_archived"; workspaceId: string }
>;

export type MessageSubmittedEvent = BaseSessionEvent<
    "message_submitted",
    {
        displayText: string;
        delivery?: "run" | "steer";
        message: UserMessage;
        mutationId?: string;
        runId: string;
        source?: "notification";
    }
>;

export type SteeringAppliedEvent = BaseSessionEvent<
    "steering_applied",
    {
        messageIds: readonly string[];
        runId: string;
    }
>;

export type RunStartedEvent = BaseSessionEvent<"run_started", { runId: string }>;

export type InferenceRetryEvent = BaseSessionEvent<
    "inference_retry",
    { attempt: number; reason: string; runId: string }
>;

export type AgentStreamEvent = BaseSessionEvent<
    "agent_event",
    {
        event: AgentLoopEvent;
        runId: string;
    }
>;

export type AgentMessageEvent = BaseSessionEvent<
    "agent_message",
    {
        message: Message;
        runId: string;
    }
>;

export type RunFinishedEvent = BaseSessionEvent<
    "run_finished",
    {
        agentRunId?: string;
        /** Present whenever `stopReason` is `error`, so the failure stays readable in history. */
        errorMessage?: string;
        modelLocked: boolean;
        runId: string;
        stopReason: StopReason;
    }
>;

export type ProviderQuotaObservedEvent = BaseSessionEvent<
    "provider_quota_observed",
    {
        observationId: string;
        phase: "before" | "after";
        providerId: string;
        quota: ProviderQuota;
        runId: string;
    }
>;

export type SessionQuotaContributionChangedEvent = BaseSessionEvent<
    "session_quota_contribution_changed",
    { observedQuota: readonly SessionQuotaContribution[] }
>;

export type RunErrorEvent = BaseSessionEvent<
    "run_error",
    {
        errorMessage: string;
        modelLocked: boolean;
        runId: string;
        startupInterruption?: true;
    }
>;

export type AbortRequestedEvent = BaseSessionEvent<
    "abort_requested",
    {
        mutationId?: string;
        runId?: string;
    }
>;

export type ShellCommandFinishedEvent = BaseSessionEvent<
    "shell_command_finished",
    RunShellCommandResult
>;

export type ShellCommandStartedEvent = BaseSessionEvent<
    "shell_command_started",
    {
        command: string;
        commandId: string;
        sessionId: number;
    }
>;

export type SubagentsSuspendedEvent = BaseSessionEvent<
    "subagents_suspended",
    {
        displayText: string;
    }
>;

/**
 * The session's durable lifecycle status changed.
 *
 * This is the persisted status, not the current-moment activity. A client needs
 * both: activity says what the session is doing, while status says whether it is
 * archived, suspended, failed, or simply idle.
 */
export type SessionStatusChangedEvent = BaseSessionEvent<
    "session_status_changed",
    { status: SessionStatus }
>;

export type SessionResetEvent = BaseSessionEvent<
    "session_reset",
    {
        snapshot: AgentSnapshot;
        /**
         * The transcript as it stands after the reset.
         *
         * The snapshot alone carries messages without the runs that produced
         * them, so a client rebuilding from it cannot say where one turn ended
         * and the next began. This keeps a rebuilt transcript as complete as the
         * one an attaching client is given.
         */
        transcript: SessionTranscriptWindow;
    }
>;

export type SessionRewoundEvent = BaseSessionEvent<
    "session_rewound",
    {
        messageId: string;
        snapshot: AgentSnapshot;
        /** The transcript as it stands after the rewind. See `SessionResetEvent`. */
        transcript: SessionTranscriptWindow;
    }
>;

export type SessionTitleChangedEvent = BaseSessionEvent<
    "session_title_changed",
    {
        errorMessage?: string;
        metadataRunId?: string;
        metadataUpdatedAt?: number;
        recap?: string;
        status: SessionTitleStatus;
        title?: string;
    }
>;

/**
 * The session started doing something different.
 *
 * The payload is the complete current activity rather than a description of the
 * change, so a client that just attached can render its status line from the
 * first one of these it sees.
 */
export type SessionActivityChangedEvent = BaseSessionEvent<
    "session_activity_changed",
    { activity: SessionActivity }
>;

/**
 * How much of the context window the conversation now occupies.
 *
 * Rig recomputes this as messages land, so it is reported rather than left for a
 * client to ask about on a timer.
 */
export type SessionContextChangedEvent = BaseSessionEvent<
    "session_context_changed",
    { sessionTokenCount: SessionTokenCount }
>;

/**
 * The Git state of the directory this session runs in.
 *
 * A UI shows the branch and the changed files next to the conversation, so the
 * session stream carries them rather than making a client open the project
 * stream as well and correlate the two.
 */
export type SessionGitChangedEvent = BaseSessionEvent<
    "session_git_changed",
    { git: GitChangeSnapshot }
>;

/** Which parts of the agent configuration one change actually altered. */
export type SessionConfigurationField = "model" | "effort" | "serviceTier";

/**
 * A change to the model, reasoning effort, or fast mode.
 *
 * Several of these can move together, most often when a message carries them, so one event
 * reports everything that changed at once. `changed` names the fields the change actually
 * altered; the remaining fields describe the resulting configuration and are always present so
 * a reader never has to reconstruct them from earlier events.
 */
export type SessionConfigurationChangedEvent = BaseSessionEvent<
    "session_configuration_changed",
    {
        changed: readonly SessionConfigurationField[];
        effort?: string;
        modelId: string;
        providerId: string;
        serviceTier: ServiceTier | null;
        snapshot: AgentSnapshot;
        mutationId?: string;
    }
>;

export type PermissionModeChangedEvent = BaseSessionEvent<
    "permission_mode_changed",
    { permissionMode: PermissionMode }
>;

/**
 * A composer draft change. The `origin` identifies the client that wrote the
 * draft so that client can ignore the echo of its own keystrokes. `updatedAt`
 * is the daemon-clamped moment the draft was typed; clients compare it against
 * their own unsent edit so the newer message wins rather than the later write.
 */
export type SessionDraftChangedEvent = BaseSessionEvent<
    "session_draft_changed",
    { draft?: string; origin?: string; updatedAt: number }
>;

export type SecretsChangedEvent = BaseSessionEvent<
    "secrets_changed",
    {
        projectSecretIds: readonly string[];
        secretIds: readonly string[];
        sessionSecretIds: readonly string[];
    }
>;

export type UserInputRequestedEvent = BaseSessionEvent<"user_input_requested", UserInputRequest>;

export type UserInputResolvedEvent = BaseSessionEvent<
    "user_input_resolved",
    {
        answers?: UserInputResponse["answers"];
        requestId: string;
        status: "answered" | "cancelled";
    }
>;

export type McpServersChangedEvent = BaseSessionEvent<
    "mcp_servers_changed",
    { servers: readonly McpServerSummary[] }
>;

export type TasksChangedEvent = BaseSessionEvent<
    "tasks_changed",
    { tasks: readonly SessionTask[] }
>;

export type GoalChangedEvent = BaseSessionEvent<"goal_changed", { goal: SessionGoal | null }>;

export type SubagentChangedEvent = BaseSessionEvent<
    "subagent_changed",
    {
        subagent: SubagentSummary;
    }
>;

export type WorkflowChangedEvent = BaseSessionEvent<
    "workflow_changed",
    {
        update: WorkflowRunUpdate;
    }
>;

export type ExternalToolCallRequestedEvent = BaseSessionEvent<
    "external_tool_call_requested",
    { call: ExternalToolCall }
>;

export type ExternalToolCallResolvedEvent = BaseSessionEvent<
    "external_tool_call_resolved",
    { call: ExternalToolCall }
>;
