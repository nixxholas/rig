/**
 * The parts of Rig's session protocol this library reads.
 *
 * They are declared here rather than imported so a browser bundle carries no
 * daemon code. `tests/protocolConformance.test.ts` checks these declarations
 * against the daemon's own types at build time, so a drift is a failed
 * type-check rather than a runtime surprise.
 */

export type EventId = string;

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

export interface PendingSteeringMessage {
    message: UserMessage;
    runId: string;
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

export interface PermissionReviewState {
    action: string;
    decision: "allow" | "deny";
    reason: string;
    risk: "low" | "medium" | "high" | "critical";
    toolCallId: string;
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
    archived: boolean;
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
    modelLocked: boolean;
    models: readonly ModelSummary[];
    snapshot: { messages: readonly Message[] };
    status: SessionStatus;
    title?: string;
    recap?: string;
    pendingUserInputs: readonly UserInputRequest[];
    pendingSteeringMessages?: readonly PendingSteeringMessage[];
    tasks: readonly SessionTask[];
    goal?: SessionGoal;
    subagents?: readonly SubagentSummary[];
    backgroundProcesses?: readonly BackgroundProcess[];
    shellCommands?: readonly ShellCommandState[];
    sessionTokenCount?: SessionTokenCount;
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
}

export interface SessionTranscriptWindow {
    messages: readonly Message[];
    messageCreatedAt?: Readonly<Record<string, number>>;
    turns: readonly SessionTranscriptTurn[];
    /** False when the conversation began before the first turn in this window. */
    complete: boolean;
}

export interface SessionStreamHello {
    activity: SessionActivity;
    session?: ProtocolSession;
    transcript?: SessionTranscriptWindow;
    partial?: SessionPartialMessage;
    lastEventId?: EventId;
    resumed: boolean;
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
    | BaseSessionEvent<"session_activity_changed", { activity: SessionActivity }>
    | BaseSessionEvent<"session_git_changed", { git: GitChangeSnapshot }>
    | BaseSessionEvent<"session_context_changed", { sessionTokenCount: SessionTokenCount }>
    | BaseSessionEvent<
          "session_configuration_changed",
          { effort?: string; modelId: string; serviceTier: string | null }
      >
    | BaseSessionEvent<
          "session_title_changed",
          { errorMessage?: string; recap?: string; status: string; title?: string }
      >
    | BaseSessionEvent<
          "session_draft_changed",
          { draft?: string; origin?: string; updatedAt: number }
      >
    | BaseSessionEvent<"user_input_requested", UserInputRequest>
    | BaseSessionEvent<
          "user_input_resolved",
          {
              answers?: Readonly<Record<string, readonly string[]>>;
              requestId: string;
              status: string;
          }
      >
    | BaseSessionEvent<"tasks_changed", { tasks: readonly SessionTask[] }>
    | BaseSessionEvent<"goal_changed", { goal: SessionGoal | null }>
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
              runId: string;
              source?: "notification";
          }
      >
    | BaseSessionEvent<"run_started", { runId: string }>
    | BaseSessionEvent<"agent_message", { message: Message; runId: string }>
    | BaseSessionEvent<"agent_event", { event: AgentLoopEvent; runId: string }>
    | BaseSessionEvent<
          "run_finished",
          { errorMessage?: string; modelLocked: boolean; runId: string; stopReason: string }
      >
    | BaseSessionEvent<"run_error", { errorMessage: string; modelLocked: boolean; runId: string }>
    | BaseSessionEvent<
          "session_reset",
          { snapshot: { messages: readonly Message[] }; transcript: SessionTranscriptWindow }
      >
    | BaseSessionEvent<
          "session_rewound",
          {
              messageId: string;
              snapshot: { messages: readonly Message[] };
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
    unread?: object;
}

export interface GlobalStreamHello {
    cursor: string;
    projects: readonly Project[];
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
    | BaseGlobalEvent<"project_created", { project: Project }>
    | BaseGlobalEvent<"project_updated", { project: Project }>
    | BaseGlobalEvent<"workspace_created", { workspace: ProjectWorkspace }>
    | BaseGlobalEvent<"workspace_updated", { workspace: ProjectWorkspace }>
    | BaseGlobalEvent<"project_git_changed", { git: GitChangeSnapshot }>
    | BaseGlobalEvent<"workspace_git_changed", { git: GitChangeSnapshot }>
    | SessionEvent;
