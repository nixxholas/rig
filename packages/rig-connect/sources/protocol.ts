/**
 * The parts of Rig's session protocol this library reads.
 *
 * They are declared here rather than imported so a browser bundle carries no
 * daemon code. `tests/protocolConformance.test.ts` checks these declarations
 * against the daemon's own types at build time, so a drift is a failed
 * type-check rather than a runtime surprise.
 */

export type EventId = string;
export type MutationId = string;

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
    label: string;
    kind: SessionActivityKind;
    runId?: string;
    since: number;
    compaction?: SessionActivityCompaction;
    pendingInputRequestIds?: readonly string[];
    retry?: SessionActivityRetry;
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
    usage?: Usage;
    providerId?: string;
    requestedModelId?: string;
    responseModel?: string;
    internal?: true;
}

export type Message = SystemMessage | UserMessage | AgentMessage;

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

export interface SessionQuotaContribution {
    providerId: string;
    windows: {
        fiveHour?: { observedUsedPercent: number };
        weekly?: { observedUsedPercent: number };
    };
}

export interface SessionUsageSnapshot {
    currentProviderId: string;
    groups: readonly SessionUsageGroup[];
    context?: SessionContextUsage;
    observedQuota: readonly SessionQuotaContribution[];
    quotas: readonly SessionProviderQuota[];
    sessionTokenCount: SessionTokenCount;
}

export interface SessionTokenCount {
    lastContextTokens: number;
    totalTokens: number;
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
}

export interface PermissionReviewState {
    action: string;
    decision: "allow" | "deny";
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
    orderKey: string;
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
}

export interface SessionPartialMessage {
    message: AgentMessage;
    runId: string;
}

export interface SessionTranscriptTurn {
    runId: string;
    messageIds: readonly string[];
    startedAt: number;
    endedAt?: number;
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

export interface SessionTranscriptWindow {
    messages: readonly Message[];
    messageCreatedAt?: Readonly<Record<string, number>>;
    messageEventId?: Readonly<Record<string, EventId>>;
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
    | BaseSessionEvent<"run_started", { runId: string }>
    | BaseSessionEvent<"abort_requested", { mutationId?: MutationId; runId?: string }>
    | BaseSessionEvent<"inference_retry", { attempt: number; reason: string; runId: string }>
    | BaseSessionEvent<"agent_message", { message: Message; runId: string }>
    | BaseSessionEvent<"agent_event", { event: AgentLoopEvent; runId: string }>
    | BaseSessionEvent<
          "provider_quota_observed",
          {
              observationId: string;
              phase: "before" | "after";
              providerId: string;
              quota: ProviderQuota;
              runId: string;
          }
      >
    | BaseSessionEvent<
          "session_quota_contribution_changed",
          { observedQuota: readonly SessionQuotaContribution[] }
      >
    | BaseSessionEvent<
          "run_finished",
          { errorMessage?: string; modelLocked: boolean; runId: string; stopReason: string }
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
    status: "initializing" | "ready" | "failed" | "archiving" | "archive_failed" | "archived";
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
    orderKey: string;
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
    unread?: object;
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

export interface GlobalStreamHello {
    catalog?: ModelCatalog;
    cursor: string;
    identity?: DaemonIdentity;
    projects: readonly Project[];
    terminalGroups: readonly RemoteTerminalGroupState[];
    workspaces: readonly ProjectWorkspace[];
    sessions: readonly SessionSummary[];
    sessionsComplete: boolean;
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
    | SessionEvent;

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
