/**
 * The parts of Rig's session protocol this library reads.
 *
 * They are declared here rather than imported so a browser bundle carries no
 * daemon code. `tests/protocolConformance.test.ts` checks these declarations
 * against the daemon's own types at build time, so a drift is a failed
 * type-check rather than a runtime surprise.
 */

import { Type } from "@sinclair/typebox";

export type EventId = string;
export type MutationId = string;

export type SessionActivityKind =
    | "idle"
    | "queued"
    | "thinking"
    | "generating_message"
    | "generating_tool_call"
    | "reviewing_tool_call"
    | "executing_tool_call"
    | "waiting"
    | "awaiting_input"
    | "compacting"
    | "retrying"
    | "stopped"
    | "error";

export interface SessionActivityToolCall {
    startedAt: number;
    status?: string;
    toolCallId: string;
    toolName: string;
}

export interface SessionActivityPermissionReview {
    action: string;
    startedAt: number;
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

export interface SessionActivityWait {
    dueAt: number;
    startedAt: number;
    toolCallId: string;
}

export interface SessionActivity {
    label: string;
    kind: SessionActivityKind;
    runId?: string;
    since: number;
    compaction?: SessionActivityCompaction;
    pendingInputRequestIds?: readonly string[];
    retry?: SessionActivityRetry;
    reviewingToolCalls?: readonly SessionActivityPermissionReview[];
    wait?: SessionActivityWait;
    toolCalls?: readonly SessionActivityToolCall[];
}

export interface TextBlock {
    type: "text";
    text: string;
}

export interface ImageBlock {
    type: "image";
    mediaType: string;
    data: string;
    detail?: "high" | "original";
}

export type Attachment =
    | {
          bytes: number;
          downloadUrl?: string;
          height: number;
          id: string;
          kind: "image";
          mediaType: string;
          name: string;
          source: string;
          thumbhash: string;
          width: number;
      }
    | {
          bytes: number;
          downloadUrl?: string;
          duration: number;
          height: number;
          id: string;
          kind: "video";
          mediaType?: string;
          name: string;
          preview: {
              height: number;
              mediaType: "image/png";
              path: string;
              thumbhash: string;
              width: number;
          };
          source: string;
          width: number;
      }
    | {
          bytes: number;
          downloadUrl?: string;
          duration: number;
          id: string;
          kind: "audio";
          mediaType?: string;
          name: string;
          source: string;
      }
    | {
          bytes: number;
          downloadUrl?: string;
          id: string;
          kind: "file";
          mediaType?: string;
          name: string;
          source: string;
      }
    | {
          description?: string;
          id: string;
          image?: string;
          kind: "url";
          siteName?: string;
          source: string;
          title: string;
      }
    | {
          description: string;
          id: string;
          image: string;
          kind: "webapp";
          name: string;
          path?: string;
          query?: Record<string, string>;
          thumbhash: string;
          webapp: string;
      };

export type ContentBlock = TextBlock | ImageBlock;

export interface ThinkingBlock {
    type: "thinking";
    thinking: string;
    encrypted?: string;
    redacted?: boolean;
}

export interface ToolCallBlock {
    type: "tool_call";
    id: string;
    providerToolCallId?: string;
    name: string;
    namespace?: string;
    arguments: unknown;
    incomplete?: boolean;
    kind?: "custom" | "function" | "tool_search";
    vendor?: unknown;
    presentation?: ToolCallPresentation;
}

export interface ToolResultFailure {
    kind: "execution_failed" | "interrupted" | "invalid_arguments" | "tool_unavailable";
    message?: string;
}

export interface ToolResultBlock {
    type: "tool_result";
    toolCallId: string;
    providerToolCallId?: string;
    toolName: string;
    rendered: readonly ContentBlock[];
    display: string;
    isError?: boolean;
    failure?: ToolResultFailure;
    presentation?: ToolResultPresentation;
    trustedUserEvidence?: readonly ContentBlock[];
    vendor?: unknown;
}

/**
 * How Rig describes what a tool is doing and what it produced.
 *
 * These mirror the daemon's own unions, which is what lets this library project
 * them into application values. `tests/protocolConformance.test.ts` fails to
 * compile if they drift.
 *
 * A consumer should read the projected `presentation` on a tool call rather than
 * these; they are exported because the projection is lossless only for the kinds
 * it knows.
 */
export type ExplorationOperation =
    | { readonly kind: "list"; readonly target: string }
    | { readonly kind: "read"; readonly name: string }
    | {
          readonly command: string;
          readonly kind: "search";
          readonly path?: string;
          readonly query?: string;
      };

export interface ExplorationToolCallPresentation {
    readonly type: "exploration";
    readonly operations: readonly ExplorationOperation[];
}

export interface ExecCommandToolCallPresentation {
    readonly command: string;
    readonly type: "exec_command";
}

export type ToolCallPresentation =
    | ExecCommandToolCallPresentation
    | ExplorationToolCallPresentation;

export type FileDiffKind = "add" | "delete" | "update";
export type FileDiffLineKind = "add" | "context" | "delete";

export interface FileDiffLine {
    readonly kind: FileDiffLineKind;
    readonly text: string;
}

export interface FileDiffHunk {
    readonly oldStart: number;
    readonly newStart: number;
    readonly lines: readonly FileDiffLine[];
}

export interface FileDiff {
    readonly path: string;
    readonly kind: FileDiffKind;
    readonly hunks: readonly FileDiffHunk[];
    readonly language?: string;
    readonly added?: number;
    readonly deleted?: number;
    readonly omittedLines?: number;
}

export interface FileDiffToolResultPresentation {
    readonly type: "file_diff";
    readonly files: readonly FileDiff[];
    readonly omittedFiles?: number;
}

export interface BackgroundTerminalInteractionPresentation {
    readonly command: string;
    readonly input: string;
    readonly sessionId: number;
    readonly type: "background_terminal_interaction";
}

export interface ExecCommandResultPresentation {
    readonly command: string;
    readonly output: string;
    readonly sessionId?: number;
    readonly type: "exec_command";
}

export type ToolResultPresentation =
    | BackgroundTerminalInteractionPresentation
    | ExecCommandResultPresentation
    | ExplorationToolCallPresentation
    | FileDiffToolResultPresentation;

export type AgentBlock = ContentBlock | ThinkingBlock | ToolCallBlock | ToolResultBlock;

export interface SystemMessage {
    role: "system";
    id: string;
    blocks: readonly ContentBlock[];
    internal?: true;
}

export interface UserMessage {
    role: "user";
    id: string;
    blocks: readonly ContentBlock[];
    provenance?: "agent";
    internal?: true;
}

export interface AgentMessage {
    role: "agent";
    id: string;
    blocks: readonly AgentBlock[];
    attachments?: readonly Attachment[];
    usage?: Usage;
    contextTokens?: number;
    providerId?: string;
    requestedModelId?: string;
    responseModel?: string;
    internal?: true;
}

export interface CompactionMessage {
    role: "compaction";
    id: string;
    blocks: readonly ContentBlock[];
    replacedMessageIds: readonly string[];
    statistics: {
        before: { exact: true; tokens: number };
        after: { exact: boolean; tokens: number };
    };
    providerId: string;
    /** Model requested for the compaction inference. */
    requestedModelId?: string;
    /** Provider-reported model that performed the compaction inference. */
    responseModel?: string;
    /** Provider-reported usage spent producing this compaction. */
    usage?: Usage;
    internal?: never;
}

export interface ErrorMessage {
    role: "error";
    id: string;
    blocks: readonly ContentBlock[];
    outcome: "retried" | "continued" | "failed";
    attempt?: number;
    context?: "excluded";
    internal?: never;
}

export type Message = SystemMessage | UserMessage | AgentMessage | CompactionMessage | ErrorMessage;

export interface Usage {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
    reasoning?: number;
    cost: {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
        total: number;
    };
}

export type ProviderQuotaWindow =
    | {
          capturedAt: number;
          status: "available";
          usedPercent: number;
          resetsAt: number;
          durationMs?: number;
      }
    | { status: "unavailable" };

export interface ProviderQuota {
    capturedAt: number;
    source: "claude" | "codex";
    windows: {
        fiveHour?: ProviderQuotaWindow;
        weekly?: ProviderQuotaWindow;
    };
}

export interface SessionUsageGroup {
    kind: "attributed";
    modelId: string;
    providerId: string;
    requestedModelId: string;
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

export interface SessionProviderQuota {
    providerId: string;
    quota: ProviderQuota;
}

export interface SessionUsageSnapshot {
    currentProviderId: string;
    groups: readonly SessionUsageGroup[];
    context?: SessionContextUsage;
    quotas: readonly SessionProviderQuota[];
    sessionTokenCount: SessionTokenCount;
}

export interface SessionTokenCount {
    /** Context window occupied after the latest inference or compaction. */
    lastContextTokens: number;
    /** Cumulative provider-reported usage across all model requests in the session. */
    totalTokens: number;
}

/**
 * Why a chat is waiting for the human.
 *
 * `attention_needed` outranks `turn_finished`: a chat that asked a question and
 * then stopped working is still asking, so the stronger reason stands rather
 * than decaying into the weaker one when the run ends.
 */
export type SessionUnreadReason = "attention_needed" | "turn_finished";

export interface SessionUnreadState {
    reason: SessionUnreadReason;
    since: number;
}

export interface ModelSummary {
    autoCompactWindow?: number;
    contextWindow?: number;
    defaultThinkingLevel: string;
    id: string;
    name: string;
    thinkingLevels: readonly string[];
}

export interface ProviderModelCatalog {
    disabledReason?: "not_authenticated" | "not_enabled" | "no_models";
    providerId: string;
    providerType?: string;
    models: readonly ModelSummary[];
    serviceTiers?: readonly string[];
}

export interface ModelCatalog {
    defaultModelId: string;
    defaultProviderId: string;
    models: readonly ModelSummary[];
    providers: readonly ProviderModelCatalog[];
}

export interface DaemonIdentity {
    developmentBuildId?: string;
    version: string;
}

export interface UserInputOption {
    description: string;
    label: string;
}

export interface UserInputQuestion {
    header: string;
    id: string;
    multiSelect: boolean;
    options: readonly UserInputOption[];
    question: string;
    required?: boolean;
}

export interface UserInputRequest {
    autoResolutionMs?: number;
    questions: readonly UserInputQuestion[];
    requestId: string;
}

export interface InboxUserInput {
    answers?: Readonly<Record<string, readonly string[]>>;
    createdAt: number;
    questions: readonly UserInputQuestion[];
    requestId: string;
    resolvedAt?: number;
    status: "pending" | "answered";
}

export interface SessionTask {
    activeForm?: string;
    blockedBy: readonly string[];
    blocks: readonly string[];
    description: string;
    id: string;
    metadata?: Readonly<Record<string, unknown>>;
    owner?: string;
    status: "pending" | "in_progress" | "completed";
    subject: string;
}

export interface SessionGoal {
    createdAt: number;
    objective: string;
    status: "active" | "blocked" | "complete" | "paused";
    updatedAt: number;
}

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

export interface BackgroundProcess {
    command: string;
    cwd: string;
    sessionId: number;
    status: "running";
}

export interface BackgroundProcessSnapshot {
    command: string;
    cwd: string;
    exitCode: number | null;
    sessionId: number;
    status: "completed" | "killed" | "running";
    stderr: string;
    stderrDelta: string;
    stdout: string;
    stdoutDelta: string;
    timedOut: boolean;
}

export interface PendingSteeringMessage {
    createdAt: number;
    message: UserMessage;
    runId: string;
}

export interface SessionActiveTurn {
    runId: string;
    startedAt: number;
    kind?: "compaction";
}

export interface PermissionReviewState {
    action: string;
    decision: "allow" | "deny";
    fullAccessGranted?: true;
    reason: string;
    risk: "low" | "medium" | "high" | "critical";
    toolCallId: string;
    userAuthorization: "unknown" | "low" | "medium" | "high";
}

export interface ShellCommandState {
    command: string;
    commandId: string;
    errorMessage?: string;
    exitCode?: number | null;
    output?: string;
    sessionId?: number;
    status: "running" | "finished";
    timedOut?: boolean;
}

export type SessionExecutionEnvironment =
    | { type: "local" }
    | {
          kind: "container" | "image";
          reference: string;
          type: "docker";
          workingDirectory: string;
      };

export interface SessionAgentMetadata {
    depth: number;
    rootSessionId: string;
    type: "primary" | "subagent";
    description?: string;
    parentSessionId?: string;
    parentToolCallId?: string;
    taskName?: string;
}

export interface SessionInterruption {
    interruptedAt: number;
    message: string;
    reason: "crash" | "shutdown";
    runId?: string;
}

export interface McpServerSummary {
    errorMessage?: string;
    name: string;
    status: "blocked" | "connected" | "disabled" | "failed";
    promptSupport?: boolean;
    resourceSupport?: boolean;
    toolCount: number;
}

export interface WorkflowRun {
    agentCount: number;
    code: string;
    description: string;
    error?: string;
    finishedAt?: number;
    logs: readonly string[];
    name: string;
    output?: unknown;
    phase?: string;
    runId: string;
    startedAt: number;
    status: "completed" | "error" | "running" | "stopped";
    taskId: string;
}

export interface WorkflowRunUpdate extends Partial<Omit<WorkflowRun, "runId">> {
    log?: string;
    runId: string;
}

export interface DurableSkillDefinition {
    description: string;
    location: "durable";
    name: string;
}

export interface ExternalToolDefinition {
    description: string;
    label?: string;
    name: string;
    parameters: unknown;
}

export type ExternalToolCallResolution =
    | { status: "completed"; content?: readonly ContentBlock[]; output?: unknown }
    | {
          status: "failed";
          error: { code?: string; data?: unknown; message: string };
      };

export interface ExternalToolCall {
    arguments: unknown;
    batchId: string;
    consumed: boolean;
    createdAt: number;
    definition: ExternalToolDefinition;
    id: string;
    providerToolCallId?: string;
    resolution?: ExternalToolCallResolution;
    resolvedAt?: number;
    runId: string;
    sessionId: string;
    skill?: DurableSkillDefinition;
    status: "pending" | "completed" | "failed" | "cancelled";
    toolCallId: string;
    toolCallIndex: number;
}

export interface GitFileChange {
    binary: boolean;
    deletions?: number;
    insertions?: number;
    path: string;
    previousPath?: string;
    staged: boolean;
    status: string;
    unstaged: boolean;
}

export interface GitChangeSnapshot {
    base?: string;
    branch?: string;
    changedFiles: number;
    comparison: "ready" | "unavailable";
    conflicted: boolean;
    countsExact: boolean;
    deletions: number;
    error?: string;
    files: readonly GitFileChange[];
    filesTruncated: boolean;
    generation: string;
    insertions: number;
    /** Stable application revision for consumers that cache file projections. */
    revision?: string;
    scannedAt: number;
    version: number;
    /** Daemon wire facts; projected to top-level application fields by rig-connect. */
    facts?: GitRepositoryFacts;
}

export interface GitWatchResponse {
    snapshots: readonly GlobalEvent[];
}

export interface GitRepositoryFacts {
    ahead: number;
    behind: number;
    branch?: string;
    detached: boolean;
    head?: string;
    upstream?: string;
}

/**
 * The durable lifecycle status of a session, as distinct from what it is doing
 * at this moment. A session list uses this for archived, suspended, and failed
 * sessions and for authoritative run completion.
 */
export type SessionStatus =
    | "idle"
    | "queued"
    | "running"
    | "completed"
    | "aborted"
    | "suspended"
    | "error"
    | "archived";

export interface ProtocolSession {
    id: string;
    activity: SessionActivity;
    activeTurn?: SessionActiveTurn;
    agentId?: string;
    agent?: SessionAgentMetadata;
    archived: boolean;
    appendSystemPrompt?: string;
    projectId: string;
    workspaceId?: string;
    /** Absent for a session with no place in an ordered list, such as a subagent. */
    orderKey?: string;
    cwd: string;
    draft?: string;
    draftUpdatedAt?: number;
    git?: GitChangeSnapshot;
    lastEventId?: EventId;
    modelId: string;
    providerId: string;
    permissionMode: string;
    effort?: string;
    serviceTier?: string;
    secretIds?: readonly string[];
    projectSecretIds?: readonly string[];
    sessionSecretIds?: readonly string[];
    environment?: SessionExecutionEnvironment;
    modelLocked: boolean;
    models: readonly ModelSummary[];
    snapshot: { messages: readonly Message[] };
    status: SessionStatus;
    title?: string;
    titleError?: string;
    titleStatus?: "error" | "generating" | "idle" | "ready";
    recap?: string;
    interruption?: SessionInterruption;
    pendingUserInputs: readonly UserInputRequest[];
    permissionReviews?: readonly PermissionReviewState[];
    pendingSteeringMessages?: readonly PendingSteeringMessage[];
    tasks: readonly SessionTask[];
    goal?: SessionGoal;
    subagents?: readonly SubagentSummary[];
    backgroundProcesses?: readonly BackgroundProcess[];
    shellCommands?: readonly ShellCommandState[];
    systemPrompt?: string;
    mcpServers?: readonly McpServerSummary[];
    workflowsEnabled?: boolean;
    workflows?: readonly WorkflowRun[];
    sessionTokenCount?: SessionTokenCount;
    externalTools?: readonly ExternalToolDefinition[];
    skills?: readonly DurableSkillDefinition[];
    pendingExternalToolCalls?: readonly ExternalToolCall[];
    scheduledMessages?: readonly ScheduledMessage[];
}

export interface ScheduledMessage {
    createdAt: number;
    dueAt: number;
    id: string;
    message: string;
    senderSessionId: string;
    status: "pending" | "delivered" | "undelivered" | "cancelled";
    targetAgentId: string;
    updatedAt: number;
    deliveredAt?: number;
    failure?: string;
}

export interface SessionPartialMessage {
    message: AgentMessage;
    runId: string;
}

export interface SessionTranscriptTurn {
    runId: string;
    kind?: "compaction";
    messageIds: readonly string[];
    startedAt: number;
    endedAt?: number;
    outcome?: "success" | "error" | "stopped";
    errorMessage?: string;
    groups?: readonly SessionTranscriptGroup[];
}

export interface SessionTranscriptGroup {
    id: string;
    startedAt: number;
    endedAt?: number;
    outcome?: "success" | "error" | "stopped";
    reason?: "completed" | "steering" | "compaction" | "abort" | "error";
    errorMessage?: string;
}

export interface SessionTranscriptWindow {
    messages: readonly Message[];
    messageCreatedAt?: Readonly<Record<string, number>>;
    messageEventId?: Readonly<Record<string, EventId>>;
    /** When each steering message was actually applied to its run. */
    messageSteeredAt?: Readonly<Record<string, number>>;
    messageBoundaryGroupId?: Readonly<Record<string, string>>;
    messageGroupId?: Readonly<Record<string, string>>;
    permissionReviews?: readonly PermissionReviewState[];
    turns: readonly SessionTranscriptTurn[];
    /** False when the conversation began before the first turn in this window. */
    complete: boolean;
}

export interface SessionStreamHello {
    activity: SessionActivity;
    current?: SessionStreamCurrentState;
    usage?: SessionUsageSnapshot;
    session?: ProtocolSession;
    transcript?: SessionTranscriptWindow;
    partial?: SessionPartialMessage;
    lastEventId?: EventId;
    resumed: boolean;
}

/**
 * A session bootstrapped by request-response rather than by opening a stream.
 *
 * `cursor` is the live-stream position this payload reflects.
 */
export interface SessionStateResponse extends SessionStreamHello {
    /** The transcript continues what the client holds rather than replacing it. */
    append?: boolean;
    cursor: EventId;
}

export interface SessionStreamCurrentState {
    draft?: string;
    draftUpdatedAt?: number;
    externalTools?: readonly ExternalToolDefinition[];
    git?: GitChangeSnapshot;
    interruption?: SessionInterruption;
    mcpServers?: readonly McpServerSummary[];
    pendingExternalToolCalls?: readonly ExternalToolCall[];
    projectSecretIds?: readonly string[];
    secretIds?: readonly string[];
    sessionTokenCount?: SessionTokenCount;
    sessionSecretIds?: readonly string[];
    skills?: readonly DurableSkillDefinition[];
    scheduledMessages?: readonly ScheduledMessage[];
    titleError?: string;
    titleStatus?: "error" | "generating" | "idle" | "ready";
    workflows?: readonly WorkflowRun[];
    workflowsEnabled?: boolean;
}

export interface BaseSessionEvent<TType extends string, TData> {
    createdAt: number;
    data: TData;
    id: EventId;
    sessionId: string;
    type: TType;
}

/**
 * The events this library interprets.
 *
 * Rig emits more than these. Anything unrecognised is ordered and cursored like
 * the rest and then ignored, so a daemon that gained an event does not break a
 * client that has not learned it yet.
 */
export type InterpretedSessionEvent =
    | BaseSessionEvent<"session_updated", { mutationId?: MutationId; session: ProtocolSession }>
    | BaseSessionEvent<"session_activity_changed", { activity: SessionActivity }>
    | BaseSessionEvent<"session_archived", { archived: boolean; mutationId?: MutationId }>
    | BaseSessionEvent<"session_git_changed", { git: GitChangeSnapshot }>
    | BaseSessionEvent<"session_context_changed", { sessionTokenCount: SessionTokenCount }>
    | BaseSessionEvent<
          "session_configuration_changed",
          {
              effort?: string;
              modelId: string;
              mutationId?: MutationId;
              providerId: string;
              serviceTier: string | null;
          }
      >
    | BaseSessionEvent<
          "permission_mode_changed",
          { mutationId?: MutationId; permissionMode: string }
      >
    | BaseSessionEvent<
          "session_title_changed",
          { errorMessage?: string; recap?: string; status: string; title?: string }
      >
    | BaseSessionEvent<
          "session_draft_changed",
          { draft?: string; mutationId?: MutationId; origin?: string; updatedAt: number }
      >
    | BaseSessionEvent<"user_input_requested", UserInputRequest>
    | BaseSessionEvent<
          "user_input_resolved",
          {
              answers?: Readonly<Record<string, readonly string[]>>;
              mutationId?: MutationId;
              requestId: string;
              status: string;
          }
      >
    | BaseSessionEvent<
          "secrets_changed",
          {
              projectSecretIds: readonly string[];
              secretIds: readonly string[];
              sessionSecretIds: readonly string[];
              mutationId?: MutationId;
          }
      >
    | BaseSessionEvent<"mcp_servers_changed", { servers: readonly McpServerSummary[] }>
    | BaseSessionEvent<"mutation_applied", { mutationId: MutationId }>
    | BaseSessionEvent<"workflow_changed", { update: WorkflowRunUpdate }>
    | BaseSessionEvent<"external_tool_call_requested", { call: ExternalToolCall }>
    | BaseSessionEvent<"external_tool_call_resolved", { call: ExternalToolCall }>
    | BaseSessionEvent<
          "scheduled_message_changed",
          { message: ScheduledMessage; mutationId?: MutationId }
      >
    | BaseSessionEvent<"scheduled_messages_pruned", { messageIds: readonly string[] }>
    | BaseSessionEvent<"tasks_changed", { tasks: readonly SessionTask[] }>
    | BaseSessionEvent<"goal_changed", { goal: SessionGoal | null; mutationId?: MutationId }>
    | BaseSessionEvent<"subagent_changed", { subagent: SubagentSummary }>
    | BaseSessionEvent<
          "shell_command_started",
          { command: string; commandId: string; sessionId: number }
      >
    | BaseSessionEvent<
          "shell_command_finished",
          {
              command: string;
              commandId: string;
              errorMessage?: string;
              exitCode: number | null;
              output: string;
              sessionId?: number;
              timedOut: boolean;
          }
      >
    | BaseSessionEvent<"steering_applied", { messageIds: readonly string[]; runId: string }>
    | BaseSessionEvent<
          "message_submitted",
          {
              delivery?: "run" | "steer";
              displayText: string;
              message: UserMessage;
              mutationId?: MutationId;
              runId: string;
              source?: "notification";
          }
      >
    | BaseSessionEvent<"run_started", { runId: string; kind?: "compaction" }>
    | BaseSessionEvent<
          "abort_requested",
          { continuePendingSteering?: true; mutationId?: MutationId; runId?: string }
      >
    | BaseSessionEvent<"agent_message", { message: Message; runId: string }>
    | BaseSessionEvent<"agent_event", { event: AgentLoopEvent; runId: string }>
    | BaseSessionEvent<"provider_quota_observed", { providerId: string; quota: ProviderQuota }>
    | BaseSessionEvent<
          "run_finished",
          {
              attachmentMessageId?: string;
              attachments?: readonly Attachment[];
              errorMessage?: string;
              modelLocked: boolean;
              runId: string;
              stopReason: string;
          }
      >
    | BaseSessionEvent<"run_error", { errorMessage: string; modelLocked: boolean; runId: string }>
    | BaseSessionEvent<
          "session_reset",
          {
              snapshot: {
                  messages: readonly Message[];
                  modelId?: string;
                  providerId?: string;
              };
              transcript: SessionTranscriptWindow;
          }
      >
    | BaseSessionEvent<
          "session_rewound",
          {
              messageId: string;
              snapshot: {
                  messages: readonly Message[];
                  modelId?: string;
                  providerId?: string;
              };
              transcript: SessionTranscriptWindow;
          }
      >;

export type SessionEvent = InterpretedSessionEvent | BaseSessionEvent<string, unknown>;

/** The streaming and tool events carried inside `agent_event`. */
export type AgentLoopEvent =
    | { type: "inference_iteration_start"; iteration: number; messageId: string }
    | { type: "block_reset"; messageId: string; partial: { blocks?: readonly AgentBlock[] } }
    | { type: "text_start"; contentIndex: number; messageId: string }
    | { type: "text_delta"; contentIndex: number; delta: string; messageId: string }
    | { type: "text_end"; contentIndex: number; content: string; messageId: string }
    | { type: "thinking_start"; contentIndex: number; messageId: string }
    | { type: "thinking_delta"; contentIndex: number; delta: string; messageId: string }
    | { type: "thinking_end"; contentIndex: number; content: string; messageId: string }
    | { type: "toolcall_start"; contentIndex: number; messageId: string }
    | { type: "toolcall_delta"; contentIndex: number; delta: string; messageId: string }
    | {
          type: "toolcall_end";
          contentIndex: number;
          messageId: string;
          toolCall: { arguments?: unknown; id: string; name: string };
      }
    | { type: "tool_execution_start"; toolCall: ToolCallBlock }
    | { type: "tool_execution_progress"; display: string; toolCallId: string }
    | { type: "tool_execution_status"; status: string; toolCallId: string }
    | {
          type: "tool_execution_end";
          result: {
              display?: string;
              failure?: ToolResultFailure;
              isError?: boolean;
              presentation?: ToolResultPresentation;
              toolCallId: string;
              toolName: string;
          };
      }
    | {
          type: "context_compaction_started";
          compactionId: string;
          estimatedTokensBefore: number;
          reason: string;
      }
    | {
          type: "context_compacted";
          compactionId: string;
          compactedMessageCount: number;
          estimatedTokensAfter: number;
          estimatedTokensBefore: number;
      }
    | {
          type: "context_compaction_finished";
          compactionId: string;
          elapsedMs: number;
          status: "cancelled" | "completed" | "failed";
          errorMessage?: string;
      }
    | {
          type: "permission_review_started";
          action: string;
          toolCallId: string;
          toolName: string;
      }
    | {
          type: "permission_review";
          action: string;
          decision: "allow" | "deny";
          reason: string;
          risk: "low" | "medium" | "high" | "critical";
          toolCallId: string;
          transcript?: {
              modelId: string;
              providerId: string;
              usage: Usage;
          };
          userAuthorization: "unknown" | "low" | "medium" | "high";
      }
    | {
          action: string;
          reason: string;
          risk: "low" | "medium" | "high" | "critical";
          type: "temporary_full_access_started";
          toolCallId: string;
          userAuthorization: "unknown" | "low" | "medium" | "high";
      }
    | {
          type: "background_processes_changed";
          processes?: readonly BackgroundProcess[];
          running: number;
      }
    | { type: "retrying"; attempt: number; reason: string }
    | { type: string };

/** A folder or repository Rig has sessions in. */
export interface Project {
    archivedAt?: number;
    avatar?: {
        hash: string;
        height: number;
        mediaType: "image/webp";
        source: string;
        url: string;
        width: number;
    };
    avatarBuiltin?: "home";
    createdAt: number;
    git?: GitRepositoryFacts;
    id: string;
    initializationError?: string;
    initializationStatus: "initializing" | "ready" | "failed";
    kind: "regular" | "home";
    name: string;
    nameSource: "folder" | "git_remote" | "user";
    orderKey: string;
    path: string;
    presence: "present" | "missing";
    settings: {
        defaultWorkspaceCompute?:
            | { generation: number; type: "local" }
            | { generation: number; image: string; type: "docker" };
    };
    updatedAt: number;
    version: number;
    worktreeSupport: "supported" | "unsupported" | "unknown";
    worktreeSupportReason?: string;
}

/** Durable Git facts. Only the branch is read here; the rest passes through. */
export interface GitRepositoryFacts {
    branch?: string;
}

/** A worktree inside a project. */
export interface ProjectWorkspace {
    archivedAt?: number;
    baseRef?: string;
    createdAt: number;
    error?: string;
    git?: GitRepositoryFacts;
    id: string;
    kind: "git_worktree";
    name: string;
    orderKey: string;
    path: string;
    presence: "present" | "missing";
    projectId: string;
    status: "initializing" | "ready" | "failed" | "archiving" | "archived";
    title?: string;
    updatedAt: number;
    version: number;
}

export interface SessionSummary {
    id: string;
    archived: boolean;
    projectId: string;
    workspaceId?: string;
    cwd: string;
    draft?: string;
    draftUpdatedAt?: number;
    providerId: string;
    modelId: string;
    /** Absent for a session with no place in an ordered list, such as a subagent. */
    orderKey?: string;
    permissionMode: string;
    effort?: string;
    serviceTier?: string;
    status: SessionStatus;
    title?: string;
    titleError?: string;
    titleStatus: string;
    recap?: string;
    sessionTokenCount?: SessionTokenCount;
    metadataUpdatedAt?: number;
    metadataRunId?: string;
    createdAt: number;
    updatedAt: number;
    lastMessageAt?: number;
    lastEventId?: EventId;
    /** The session's current activity wait, present while the agent is inside a scheduled wait. */
    wait?: SessionActivityWait;
    /** Whether the daemon keeps unread state for this chat at all. */
    trackUnread?: boolean;
    unread?: SessionUnreadState;
    inboxItems?: readonly InboxUserInput[];
}

export interface RemoteTerminalSummary {
    cols: number;
    epoch: string;
    exitCode: number | null;
    id: string;
    rows: number;
    status: "exited" | "running";
}

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

export interface PluginAppContribution {
    appId: string;
    generation: string;
    id: string;
    page: string;
    pluginFolder: string;
    resourceUri: string;
    resources: readonly {
        mimeType: string;
        path: string;
        size: number;
        uri: string;
    }[];
    sidebar: {
        icon?: string;
        label: string;
        order: number;
    };
    title: string;
    tools: readonly {
        _meta: {
            ui: {
                resourceUri: string;
                visibility: readonly ("app" | "model")[];
            };
        };
        description: string;
        name: string;
        server: string;
    }[];
}

const exact = { additionalProperties: false } as const;
const pluginResourcePathSchema = Type.String({
    maxLength: 160,
    minLength: 1,
    pattern: "^(?!/)(?!.*//)(?!.*(?:^|/)\\.{1,2}(?:/|$))(?!.*\\\\)[A-Za-z0-9][A-Za-z0-9._/-]*$",
});
const pluginResourceUriSchema = Type.String({
    pattern: "^ui://[^/?#]+/[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?/[A-Za-z0-9][A-Za-z0-9._/-]*$",
});

/**
 * Browser-safe runtime boundary for the locally re-declared plugin catalog.
 *
 * `protocolConformance.test.ts` pins the corresponding TypeScript interface to Rig's daemon
 * declaration. This schema deliberately lives here rather than importing the Node-oriented plugin
 * SDK into the browser client.
 */
export const pluginAppContributionSchema = Type.Object(
    {
        appId: Type.String({
            maxLength: 64,
            minLength: 1,
            pattern: "^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$",
        }),
        generation: Type.String({ minLength: 1 }),
        id: Type.String({ minLength: 1 }),
        page: pluginResourcePathSchema,
        pluginFolder: Type.String({ minLength: 1 }),
        resourceUri: pluginResourceUriSchema,
        resources: Type.Array(
            Type.Object(
                {
                    mimeType: Type.String(),
                    path: pluginResourcePathSchema,
                    size: Type.Integer({ maximum: 256 * 1024, minimum: 0 }),
                    uri: pluginResourceUriSchema,
                },
                exact,
            ),
            { maxItems: 64, minItems: 1 },
        ),
        sidebar: Type.Object(
            {
                icon: Type.Optional(pluginResourcePathSchema),
                label: Type.String({ maxLength: 64, minLength: 1 }),
                order: Type.Integer({ maximum: 1_000, minimum: -1_000 }),
            },
            exact,
        ),
        title: Type.String({ maxLength: 128, minLength: 1 }),
        tools: Type.Array(
            Type.Object(
                {
                    _meta: Type.Object(
                        {
                            ui: Type.Object(
                                {
                                    resourceUri: pluginResourceUriSchema,
                                    visibility: Type.Array(
                                        Type.Union([Type.Literal("model"), Type.Literal("app")]),
                                        { maxItems: 2, minItems: 1, uniqueItems: true },
                                    ),
                                },
                                exact,
                            ),
                        },
                        exact,
                    ),
                    description: Type.String({ minLength: 1 }),
                    name: Type.String({ minLength: 1 }),
                    server: Type.String({ minLength: 1 }),
                },
                exact,
            ),
        ),
    },
    exact,
);

export interface PluginSummary {
    apps: readonly PluginAppContribution[];
    /** The folder the plugin writes to, which the user can open. */
    dataDirectory: string;
    description: string;
    /** Where Rig installed the plugin's code. */
    directory: string;
    folder: string;
    error?: string;
    logAvailable: boolean;
    name: string;
    status: "build_failed" | "running" | "stopped";
}

export interface PluginLogSnapshot {
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
    cursor: string;
    failures: readonly { error: string; folder: string }[];
    plugins: readonly PluginSummary[];
    version: string;
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

/** The catalog snapshot returned by `GET /catalog`. */
export interface GlobalStreamHello {
    catalog: ModelCatalog;
    cursor: string;
    identity: DaemonIdentity;
    presence: PresenceSnapshot;
    protocolVersion: number;
    projects: readonly Project[];
    terminalGroups: readonly RemoteTerminalGroupState[];
    workspaces: readonly ProjectWorkspace[];
    sessions: readonly SessionSummary[];
    sessionsComplete: boolean;
}

/** How much of Rig one timeline covers. */
export type TimelineScope =
    | { kind: "global" }
    | { kind: "project"; projectId: string }
    | { kind: "session"; sessionId: string }
    | { kind: "workspace"; projectId: string; workspaceId: string };

export type TimelineSpanKind = "asking" | "waiting" | "working";

export type TimelineSpanOutcome =
    | "aborted"
    | "answered"
    | "cancelled"
    | "completed"
    | "error"
    | "interrupted";

export interface TimelineSpan {
    startedAt: number;
    endedAt?: number;
    kind: TimelineSpanKind;
    outcome?: TimelineSpanOutcome;
    requestId?: string;
    runId?: string;
}

export interface TimelineAgent {
    agentId: string;
    createdAt: number;
    depth: number;
    label: string;
    modelId: string;
    parentSessionId?: string;
    parentToolCallId?: string;
    projectId: string;
    providerId: string;
    sessionId: string;
    spans: readonly TimelineSpan[];
    type: "primary" | "subagent";
    workspaceId?: string;
}

export interface GetTimelineRequest {
    includeArchived?: boolean;
    scope: TimelineScope;
    since?: number;
}

/** The chart snapshot returned by `POST /timeline`. */
export interface GetTimelineResponse {
    agents: readonly TimelineAgent[];
    cursor: string;
    scope: TimelineScope;
}

export interface BaseGlobalEvent<TType extends string, TData> {
    createdAt: number;
    data: TData;
    id: string;
    projectId: string;
    type: TType;
    workspaceId?: string;
}

export type GlobalEvent =
    | BaseGlobalEvent<"project_created", { mutationId?: MutationId; project: Project }>
    | BaseGlobalEvent<"project_updated", { mutationId?: MutationId; project: Project }>
    | BaseGlobalEvent<"workspace_created", { mutationId?: MutationId; workspace: ProjectWorkspace }>
    | BaseGlobalEvent<"workspace_updated", { mutationId?: MutationId; workspace: ProjectWorkspace }>
    | BaseGlobalEvent<"project_git_changed", { git: GitChangeSnapshot }>
    | BaseGlobalEvent<"workspace_git_changed", { git: GitChangeSnapshot }>
    | BaseGlobalEvent<"remote_terminals_changed", { terminals: readonly RemoteTerminalSummary[] }>
    | BaseSessionEvent<"session_current", { session: SessionSummary }>
    | {
          createdAt: number;
          data: { presence: PresenceSnapshot };
          id: string;
          type: "presence_changed";
      }
    | {
          createdAt: number;
          data: {
              failures: readonly { error: string; folder: string }[];
              plugins: readonly PluginSummary[];
              version: string;
          };
          id: string;
          type: "plugins_changed";
      }
    | {
          createdAt: number;
          data: { entries: readonly SlotEntry[] };
          id: string;
          type: "slots_changed";
      }
    | {
          createdAt: number;
          data: { webapps: readonly Webapp[] };
          id: string;
          type: "webapps_changed";
      }
    | SessionEvent;

/** The fixed Happy UI locations an agent can plug content into. */
export type SlotName = "above-composer" | "sidebar" | "status-line" | "title";

export type SlotScope = "everywhere" | "project" | "session" | "workspace";

export type SlotAction =
    | { message: string; type: "send-current-chat" }
    | {
          path?: string;
          query?: Record<string, string>;
          type: "open-webapp";
          webapp: string;
      }
    | { message: string; sessionId: string; type: "send-chat" }
    | { message: string; sessionId: string; type: "draft-chat" }
    | {
          effort?: string;
          model?: string;
          projectId?: string;
          prompt?: string;
          type: "new-chat";
          workspaceId?: string;
      };

export type SlotContent =
    | { markdown: string; type: "text" }
    | { action: SlotAction; label: string; type: "button" };

export interface SlotEntry {
    authorSessionId: string;
    content: SlotContent;
    createdAt: number;
    description: string;
    id: string;
    projectId?: string;
    purpose: string;
    scope: SlotScope;
    sessionId?: string;
    slot: SlotName;
    updatedAt: number;
}

export interface WebappVersion {
    changeDescription: string;
    createdAt: number;
    version: number;
}

/** An imported, versioned webapp whose current version rig serves as static files. */
export interface Webapp {
    authorSessionId: string;
    createdAt: number;
    currentVersion: number;
    description: string;
    iconThumbhash: string;
    iconUrl: string;
    name: string;
    purpose: string;
    sourceDescription?: string;
    updatedAt: number;
    versions: readonly WebappVersion[];
}

export interface MutationRequest {
    mutationId: MutationId;
}

export interface SendMessageMutationRequest extends MutationRequest {
    clientSubmissionId: MutationId;
    content?: readonly ContentBlock[];
    displayText?: string;
    text: string;
}

export interface SwitchModelMutationRequest extends MutationRequest {
    modelId: string;
    providerId?: string;
}

export interface RenameGroupMutationRequest extends MutationRequest {
    name: string;
}

/** One rate-limit or spend window a provider reports. */
export interface ProviderUsageWindow {
    usedPercent: number;
    resetsAt: number | null;
    startsAt: number | null;
    durationMs: number | null;
}

/** Money an account can still spend once its rate-limit window is used up. */
export interface ProviderUsageCredits {
    available: boolean;
    remainingCents: number | null;
    unlimited: boolean;
    usedPercent: number | null;
}

/** One reading of an account's usage, normalized across vendors. */
export interface ProviderUsage {
    providerId: string;
    vendor: "claude" | "codex" | "grok";
    capturedAt: number;
    planName: string | null;
    exhausted: boolean;
    windows: {
        fiveHour: ProviderUsageWindow | null;
        weekly: ProviderUsageWindow | null;
        monthly: ProviderUsageWindow | null;
    };
    credits: ProviderUsageCredits | null;
}

export interface ProviderUsageEntry {
    providerId: string;
    usage: ProviderUsage | null;
    checkedAt: number | null;
    error: string | null;
}

export interface ListProviderUsageResponse {
    providers: readonly ProviderUsageEntry[];
}
