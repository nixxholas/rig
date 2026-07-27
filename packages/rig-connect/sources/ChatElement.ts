import type { ToolPresentation } from "./ToolPresentation.js";
import type { GitChangeSnapshot, SessionActivity, SessionTokenCount, Usage } from "./protocol.js";

/**
 * One row of a conversation.
 *
 * The chat state is a flat, time-ordered list of these. A tool call is its own
 * element rather than something nested inside the message that produced it, so a
 * consumer renders the list in order and never walks a tree.
 */
export type ChatElement =
    | UserMessageElement
    | AgentTextElement
    | ThinkingElement
    | ToolCallElement
    | CompactionElement
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
    text: string;
    /** Images and other non-text content the user sent. */
    attachments?: readonly { data: string; mediaType: string }[];
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
    /** Wall-clock time from the turn's first element to this one. */
    elapsedMs: number;
    usage?: Usage;
}

/** Live facts a UI shows next to the conversation. */
export interface SessionState {
    activity: SessionActivity;
    sessionId: string;
    cwd: string;
    modelId: string;
    providerId: string;
    title?: string;
    git?: GitChangeSnapshot;
    tokens?: SessionTokenCount;
    /** Whether the library currently has a live connection to the daemon. */
    connection: ConnectionState;
    /**
     * False when the conversation began before the first element in the list.
     * The opening frame carries a bounded window so attaching stays cheap on a
     * long session; a UI that scrolls back asks for the earlier messages.
     */
    transcriptComplete: boolean;
}

export type ConnectionState = "connecting" | "live" | "reconnecting" | "closed";

/** What changed, for a consumer that reacts to events rather than re-rendering. */
export type ChatDelta =
    | { type: "elements_changed"; elements: readonly ChatElement[] }
    | { type: "session_changed"; session: SessionState }
    | { type: "turn_started"; turnId: string }
    | { type: "turn_ended"; turnId: string; outcome: TurnEndElement["outcome"] }
    | { type: "compaction_started"; compactionId: string }
    | { type: "compaction_finished"; compactionId: string }
    | { type: "retry_started"; attempt: number; reason: string }
    | { type: "retry_finished" }
    | { type: "connection_changed"; connection: ConnectionState };
