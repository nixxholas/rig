export interface SessionTextBlock {
    readonly type: "text";
    readonly text: string;
}

export interface SessionImageBlock {
    readonly type: "image";
    readonly data: string;
    readonly mimeType: string;
}

export type SessionInputBlock = SessionTextBlock | SessionImageBlock;
export type SessionOutputBlock = SessionTextBlock | SessionImageBlock;

export interface SessionUserMessage {
    readonly role: "user";
    readonly content: readonly SessionInputBlock[];
}

/**
 * Opaque Codex-native message exchanged between collaborating Codex agents.
 *
 * Other providers ignore this block. Callers should only persist and replay values emitted by a
 * Codex integration; the encrypted payload is not a general-purpose application message.
 */
export interface SessionAgentMessage {
    readonly role: "agent";
    readonly author: string;
    readonly recipient: string;
    readonly header: string;
    readonly encryptedContent: string;
    /** Whether this message establishes the boundary for a new inference turn. */
    readonly agentMessageTriggerTurn?: boolean;
}

export interface SessionSystemMessage {
    readonly role: "system";
    readonly content: readonly SessionTextBlock[];
}

/**
 * One reasoning block retained exactly as the caller supplied it.
 *
 * Anthropic signs the text of its thinking blocks, so a signature replayed beside different text
 * is rejected. Unsigned reasoning still remains part of caller-owned history even when a vendor
 * must omit it while serializing a request. Providers can retain the replay payload directly on
 * the block without flattening it onto the surrounding message.
 */
export interface SessionReasoningBlock {
    readonly type: "reasoning";
    /** Human-readable reasoning, when the provider exposes it. */
    readonly text?: string;
    /** Opaque signed or encrypted reasoning required for faithful replay. */
    readonly reasoning?: string;
}

export interface SessionAssistantMessage {
    readonly role: "assistant";
    readonly content: readonly SessionAssistantBlock[];
}

export interface SessionToolCallBlock {
    readonly type: "tool_call";
    readonly callId: string;
    readonly name: string;
    readonly namespace?: string;
    readonly arguments: string;
    /** The provider stopped before this call became executable. */
    readonly incomplete?: boolean;
    /** Opaque provider metadata persisted with this tool call. */
    readonly vendor?: any;
    /** The provider executed this call and settled it inside the assistant response. */
    readonly server?: true;
}

export interface SessionToolResultBlock {
    readonly type: "tool_result";
    readonly callId: string;
    readonly content: readonly SessionOutputBlock[];
    readonly isError?: boolean;
    readonly incomplete?: boolean;
    readonly vendor?: any;
}

export type SessionAssistantBlock =
    | SessionTextBlock
    | SessionReasoningBlock
    | SessionToolCallBlock
    | SessionToolResultBlock;

export interface SessionToolResultMessage {
    readonly role: "tool";
    readonly callId: string;
    readonly content: readonly SessionOutputBlock[];
    /** Whether the caller reported that the tool invocation failed. */
    readonly isError?: boolean;
    /** Opaque provider metadata persisted with this tool result. */
    readonly vendor?: any;
}

/** Opaque provider-native context checkpoint returned by a compaction request. */
export interface SessionCompactionMessage {
    readonly role: "compaction";
    /** Provider-returned summary text, including null when the provider returned no text. */
    readonly content: string | null;
    /** Provider-returned encrypted compaction payload, including null when absent. */
    readonly encryptedContent: string | null;
    /** Additional opaque provider metadata required to replay the checkpoint natively. */
    readonly vendor?: any;
}

export type SessionMessage =
    | SessionSystemMessage
    | SessionUserMessage
    | SessionAgentMessage
    | SessionAssistantMessage
    | SessionToolResultMessage
    | SessionCompactionMessage;

/** Conversation context supplied by the caller for each run or compact. */
export interface SessionContext {
    readonly instructions: string;
    readonly messages: readonly SessionMessage[];
}
