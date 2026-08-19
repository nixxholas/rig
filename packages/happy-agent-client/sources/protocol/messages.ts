/**
 * Messages and runs: what the user sends, and the work the agent does in response.
 *
 * One message shape carries the whole conversation — history, send acceptances,
 * and events all speak it.
 */

import type { Cuid2, EventCursor, MessageMode, Timestamp } from "./common.js";
import type { UsageBreakdown } from "./usage.js";

/** A tool call rendered for display, from a closed set every client implements once. */
export type ToolPresentation =
    | ExplorationPresentation
    | ExecCommandPresentation
    | BackgroundTerminalInteractionPresentation
    | FileDiffPresentation
    | SearchPresentation;

/** Reading around the codebase: listings, file reads, and searches. */
export interface ExplorationPresentation {
    type: "exploration";
    operations: ExplorationOperation[];
}

/** One read the exploration performed: a listing, a file read, or a search. */
export type ExplorationOperation =
    | { kind: "list"; target: string }
    | { kind: "read"; name: string }
    | { kind: "search"; command: string; query?: string; path?: string };

/** A shell command; `output` arrives on completion. */
export interface ExecCommandPresentation {
    type: "exec_command";
    command: string;
    output?: string | null;
    /** Set when the command kept running and became a background terminal. */
    terminalId?: Cuid2 | null;
}

/** Input typed into an existing background terminal. */
export interface BackgroundTerminalInteractionPresentation {
    type: "background_terminal_interaction";
    terminalId: Cuid2;
    /** What the terminal is running. */
    command: string;
    /** What was typed into it. */
    input: string;
}

/** File changes, one or many files per call. */
export interface FileDiffPresentation {
    type: "file_diff";
    files: FileDiff[];
    /** How many files the call changed but the presentation left out. */
    omittedFiles?: number;
}

/** One file's changes inside a diff presentation. */
export interface FileDiff {
    path: string;
    kind: "add" | "delete" | "update";
    /** For syntax highlighting, when the daemon could name the language. */
    language?: string;
    added: number;
    deleted: number;
    /** How many lines this file's hunks left out. */
    omittedLines?: number;
    hunks: FileDiffHunk[];
}

/** A contiguous run of diff lines, numbered against both sides. */
export interface FileDiffHunk {
    oldStart: number;
    newStart: number;
    lines: FileDiffLine[];
}

/** One line of a hunk. */
export interface FileDiffLine {
    kind: "context" | "add" | "delete";
    text: string;
}

/** A web or X search; `sources` arrives on completion. */
export interface SearchPresentation {
    type: "search";
    target: "web" | "x";
    query: string;
    sources?: SearchSource[];
}

/** One source a search drew from. */
export interface SearchSource {
    url: string;
    title: string;
}

/** What is in a message, in order. */
export type MessageBlock = TextBlock | ImageBlock | ReasoningBlock | ToolCallBlock;

/** Plain text. */
export interface TextBlock {
    type: "text";
    text: string;
}

/** An image travelling inline with the message. */
export interface ImageBlock {
    type: "image";
    mimeType: string;
    /** Base64 image bytes, travelling inline. */
    data: string;
}

/** The model's thinking summary, when the provider surfaces one. */
export interface ReasoningBlock {
    type: "reasoning";
    text: string;
}

/** One tool invocation. */
export interface ToolCallBlock {
    type: "tool_call";
    name: string;
    status: "running" | "completed" | "failed";
    /** Raw tool arguments; absent under `omitToolData`. */
    arguments?: Record<string, unknown>;
    /** Raw tool result; absent under `omitToolData` and until the call finishes. */
    result?: Record<string, unknown>;
    /** A typed rendering of what the call did, when the daemon produced one. */
    presentation?: ToolPresentation;
}

/** Whether a message waits behind the current run or interrupts it. */
export type MessageDelivery = "queue" | "steer";

/** A message, whoever produced it. */
export type Message = UserMessage | AgentMessage | SystemMessage | ServiceMessage;

/** Sent by a person. */
export interface UserMessage {
    id: Cuid2;
    role: "user";
    createdAt: Timestamp;
    content: MessageBlock[];
    /** `"pending"` until inference takes the message up. */
    status: "pending" | "accepted";
    delivery: MessageDelivery;
    mode: MessageMode;
    /** `null` while pending; assigned at acceptance and the handle for abort. */
    runId: Cuid2 | null;
}

/** Produced by the model: its text, reasoning, and tool calls. */
export interface AgentMessage {
    id: Cuid2;
    role: "agent";
    createdAt: Timestamp;
    content: MessageBlock[];
}

/** Content the daemon injected into the model's context, when worth showing. */
export interface SystemMessage {
    id: Cuid2;
    role: "system";
    createdAt: Timestamp;
    content: MessageBlock[];
}

/** Operational records the model never saw: compaction, aborts, housekeeping. */
export interface ServiceMessage {
    id: Cuid2;
    role: "service";
    createdAt: Timestamp;
    content: MessageBlock[];
}

/** The run's outcome. */
export type RunStatus = "running" | "completed" | "aborted" | "failed";
/** Why a run ended; status is the outcome, reason is the cause. */
export type RunReason = "completed" | "steering" | "abort" | "error";

/** The work an agent did in response to a message. */
export interface Run {
    id: Cuid2;
    status: RunStatus;
    reason: RunReason | null;
    startedAt: Timestamp;
    endedAt: Timestamp | null;
    usage: UsageBreakdown;
    costUsd: number | null;
}

/** One whole history group, with its messages oldest first. */
export interface HistoryRun extends Run {
    /** Oldest first. */
    messages: Message[];
}

/** `POST /v0/agents/:agentId/send` */
export interface SendMessageRequest {
    /** The message text. Required. */
    text: string;
    /** Optional rich blocks accompanying the text; image bytes travel inline. */
    content?: MessageBlock[];
    /** Defaults to `"queue"`. On an idle agent the two are identical. */
    delivery?: MessageDelivery;
    /** The model selection and permission mode this message runs with. */
    mode: MessageMode;
    mutationId?: string;
}

/** `POST /v0/agents/:agentId/send` */
export interface SendMessageResponse {
    message: UserMessage;
    /** The event cursor at send; streaming from it replays everything this causes. */
    cursor: EventCursor;
}

/** `GET /v0/agents/:agentId/messages` query parameters. */
export interface MessageHistoryQuery {
    /** A run ID; return runs older than it. Cannot be combined with `after`. */
    before?: Cuid2;
    /** A message ID; return the messages that came after it. */
    after?: Cuid2;
    /**
     * A lower bound counted in messages, not an upper one: a page always
     * contains whole runs and may overflow well past it.
     */
    limit?: number;
    /** Drop `arguments` and `result` from tool calls that carry a presentation. */
    omitToolData?: boolean;
}

/** `GET /v0/agents/:agentId/messages` */
export interface MessageHistoryResponse {
    /** Oldest first, whole runs only. */
    runs: HistoryRun[];
    /**
     * Messages sent but not yet accepted by inference. Every history load
     * returns the complete list regardless of cursors.
     */
    pending: UserMessage[];
    hasMore: boolean;
}
