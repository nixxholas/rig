import type { ToolPresentation } from "./ToolPresentation.js";
import type {
    BackgroundProcess,
    DurableSkillDefinition,
    ExternalToolCall,
    ExternalToolDefinition,
    GitChangeSnapshot,
    McpServerSummary,
    ModelSummary,
    PendingSteeringMessage,
    PermissionReviewState,
    SessionActivity,
    SessionAgentMetadata,
    SessionExecutionEnvironment,
    SessionGoal,
    SessionInterruption,
    SessionStatus,
    SessionTask,
    SessionTokenCount,
    SessionUsageSnapshot,
    ShellCommandState,
    SubagentSummary,
    Usage,
    UserInputRequest,
    WorkflowRun,
} from "./protocol.js";

/**
 * One row of a conversation.
 *
 * The chat state is a flat, time-ordered list of these. A tool call is its own
 * element rather than something nested inside the message that produced it, so a
 * consumer renders the list in order and never walks a tree.
 */
export type ChatElement =
    | UserMessageElement
    | SystemNoticeElement
    | AgentTextElement
    | ThinkingElement
    | ToolCallElement
    | CompactionElement
    | RetryElement
    | TurnEndElement;

interface BaseChatElement {
    /** Stable for the life of the element; deltas never change it. */
    id: string;
    /** The turn this element belongs to. */
    turnId: string;
    /** When the element first appeared, in milliseconds since the epoch. */
    createdAt: number;
}

export interface UserMessageElement extends BaseChatElement {
    kind: "user_message";
    /** Durable source identity; consumers never need to parse the element id. */
    messageId: string;
    /** Whether this bubble is still queued to steer the active run. */
    delivery: "pending_steering" | "sent";
    /** Present for workflow/subagent news injected by Rig rather than typed by the user. */
    source?: "notification";
    text: string;
    /** Images and other non-text content the user sent. */
    attachments?: readonly { data: string; mediaType: string }[];
}

/** A non-internal system message intended for the person reading the transcript. */
export interface SystemNoticeElement extends BaseChatElement {
    kind: "system_notice";
    text: string;
}

export interface AgentTextElement extends BaseChatElement {
    kind: "agent_text";
    text: string;
    /** False while the model is still producing this text. */
    complete: boolean;
}

export interface ThinkingElement extends BaseChatElement {
    kind: "thinking";
    text: string;
    complete: boolean;
}

export type ToolCallStatus = "pending" | "running" | "succeeded" | "failed" | "interrupted";

export interface ToolCallElement extends BaseChatElement {
    kind: "tool_call";
    toolCallId: string;
    name: string;
    /** Fills in as the model streams the call; complete once `argumentsComplete`. */
    arguments: unknown;
    argumentsComplete: boolean;
    status: ToolCallStatus;
    /** Latest short label the tool reported while running. */
    progress?: string;
    /** Human-readable summary of the result. */
    result?: string;
    /**
     * What the call is doing and what it produced, in application terms.
     *
     * Narrow on `kind`. The call and its result are projected into this one
     * value, so it gains detail as the tool progresses rather than being
     * replaced by a differently shaped one.
     */
    presentation?: ToolPresentation;
    /** The complete automatic review associated with this action, when one was required. */
    permissionReview?: PermissionReviewState;
    /** Set when related calls were issued together, so a UI can draw one unit. */
    groupId?: string;
}

export interface CompactionElement extends BaseChatElement {
    kind: "compaction";
    compactionId: string;
    status: "running" | "completed" | "cancelled" | "failed";
    estimatedTokensBefore: number;
    estimatedTokensAfter?: number;
    messagesCompacted?: number;
}

/** One provider retry retained in the transcript at the moment it occurred. */
export interface RetryElement extends BaseChatElement {
    kind: "retry";
    attempt: number;
    reason: string;
}

/**
 * The last element of a turn.
 *
 * Every turn has exactly one, and it states how the turn ended. A consumer never
 * has to infer completion from silence.
 */
export interface TurnEndElement extends BaseChatElement {
    kind: "turn_end";
    outcome: "success" | "error" | "stopped";
    /** Present when the turn ended in an error. */
    errorMessage?: string;
    /** Authoritative wall-clock start from the original run submission. */
    startedAt: number;
    /** Authoritative wall-clock completion time. */
    endedAt: number;
    /** Convenience duration derived from `startedAt` and `endedAt`. */
    elapsedMs: number;
    usage?: Usage;
}

/** The turn currently occupying the session. */
export interface ActiveTurn {
    turnId: string;
    /** Stable across every activity transition, reconnect, retry, and steering segment. */
    startedAt: number;
}

export interface SessionUsage extends SessionUsageSnapshot {
    /** Total billed tokens across every attributed model and permission reviewer. */
    totalTokens: number;
    /** Total reported US-dollar cost across every attributed usage group. */
    totalCost: number;
}

/** Live facts a UI shows next to the conversation. */
export interface SessionState {
    activity: SessionActivity;
    activeTurn?: ActiveTurn;
    /**
     * The durable lifecycle status, as opposed to `activity`, which describes
     * only the current moment. A session list needs this to tell a suspended or
     * failed session from an idle one.
     */
    status: SessionStatus;
    /** Whether the session has been archived out of the active list. */
    archived: boolean;
    appendSystemPrompt?: string;
    sessionId: string;
    agentId?: string;
    agent?: SessionAgentMetadata;
    lastEventId?: string;
    projectId: string;
    workspaceId?: string;
    orderKey: string;
    cwd: string;
    draft?: string;
    draftUpdatedAt?: number;
    modelId: string;
    providerId: string;
    title?: string;
    recap?: string;
    titleError?: string;
    titleStatus: "error" | "generating" | "idle" | "ready";
    interruption?: SessionInterruption;
    /** How hard the model is asked to think, when the provider offers a choice. */
    effort?: string;
    serviceTier?: string;
    environment?: SessionExecutionEnvironment;
    secretIds: readonly string[];
    projectSecretIds: readonly string[];
    sessionSecretIds: readonly string[];
    permissionMode: string;
    /** True when the session is pinned to its model and cannot switch. */
    modelLocked: boolean;
    models: readonly ModelSummary[];
    pendingUserInputs: readonly UserInputRequest[];
    pendingSteeringMessages: readonly PendingSteeringMessage[];
    tasks: readonly SessionTask[];
    goal?: SessionGoal;
    subagents: readonly SubagentSummary[];
    backgroundProcesses: readonly BackgroundProcess[];
    shellCommands: readonly ShellCommandState[];
    systemPrompt?: string;
    mcpServers: readonly McpServerSummary[];
    workflowsEnabled: boolean;
    workflows: readonly WorkflowRun[];
    externalTools: readonly ExternalToolDefinition[];
    skills: readonly DurableSkillDefinition[];
    pendingExternalToolCalls: readonly ExternalToolCall[];
    permissionReviews: readonly PermissionReviewState[];
    git?: GitChangeSnapshot;
    tokens?: SessionTokenCount;
    /** Complete usage/cost/context/quota state maintained from the same session stream. */
    usage?: SessionUsage;
    /** Whether the library currently has a live connection to the daemon. */
    connection: ConnectionState;
    /**
     * False when the conversation began before the first element in the list.
     * The opening frame carries a bounded window so attaching stays cheap on a
     * long session; a UI that scrolls back asks for the earlier messages.
     */
    transcriptComplete: boolean;
    /**
     * Opaque identity of the oldest loaded message. Pass this exact value to
     * `loadMore`; it changes when an earlier page lands and disappears at the
     * beginning of the conversation.
     */
    loadMoreToken?: string;
    /** True while the page identified by `loadMoreToken` is being fetched. */
    loadingMore: boolean;
    /** Why the last attempt to load more history failed, in words a UI can show. */
    loadMoreError?: string;
}

export type ConnectionState = "connecting" | "live" | "reconnecting" | "closed";

export type MutationAction =
    | "create_session"
    | "fork_session"
    | "send_message"
    | "stop_run"
    | "switch_model"
    | "set_effort"
    | "set_service_tier"
    | "set_permission_mode"
    | "set_draft"
    | "set_append_system_prompt"
    | "answer_user_input"
    | "set_goal"
    | "set_goal_status"
    | "clear_goal"
    | "compact_session"
    | "reset_session"
    | "rewind_session"
    | "attach_secret"
    | "detach_secret"
    | "run_shell_command"
    | "stop_background_process"
    | "stop_background_processes"
    | "resolve_external_tool_call"
    | "record_activity"
    | "stop_workflow"
    | "set_session_archived"
    | "rename_group";

export interface MutationRejectedDelta {
    action: MutationAction;
    /** Ready-to-display explanation of why Rig did not accept the action. */
    message: string;
    mutationId: string;
    type: "mutation_rejected";
}

/** What changed, for a consumer that reacts to events rather than re-rendering. */
export type ChatDelta =
    | { type: "elements_changed"; elements: readonly ChatElement[] }
    | { type: "session_changed"; session: SessionState }
    | { type: "turn_started"; turnId: string; startedAt: number }
    | {
          type: "turn_ended";
          turnId: string;
          outcome: TurnEndElement["outcome"];
          startedAt: number;
          endedAt: number;
      }
    | { type: "compaction_started"; compactionId: string }
    | { type: "compaction_finished"; compactionId: string }
    | { type: "retry_started"; attempt: number; reason: string }
    | { type: "retry_finished" }
    | { type: "connection_changed"; connection: ConnectionState }
    | MutationRejectedDelta;
