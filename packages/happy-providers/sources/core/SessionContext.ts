export interface SessionTextContent {
    readonly type: "text";
    readonly text: string;
}

export interface SessionImageContent {
    readonly type: "image";
    readonly data: string;
    readonly mimeType: string;
}

export type SessionInputContent = readonly (SessionTextContent | SessionImageContent)[];

export interface SessionUserMessage {
    readonly role: "user";
    readonly content: string;
    /** Background context that does not establish a provider turn boundary. */
    readonly contextOnly?: true;
    /** Ordered multimodal content. When present, providers use this instead of content. */
    readonly input?: SessionInputContent;
}

/** Opaque provider-native message exchanged between collaborating Codex agents. */
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
    readonly content: string | readonly string[];
}

/**
 * One reasoning block retained exactly as the caller supplied it.
 *
 * Anthropic signs the text of its thinking blocks, so a signature replayed beside different text
 * is rejected. Unsigned reasoning still remains part of caller-owned history even when a vendor
 * must omit it while serializing a request. Vendors that hand back reasoning as one opaque payload
 * use `encryptedReasoning` instead.
 */
export interface SessionReasoning {
    readonly text: string;
    readonly signature?: string;
    /** Reasoning the vendor withheld, where the signature is the whole payload. */
    readonly redacted?: boolean;
}

export interface SessionAssistantMessage {
    readonly role: "assistant";
    readonly content: string;
    /** Opaque encrypted reasoning JSON from a prior Responses-compatible response. */
    readonly encryptedReasoning?: string;
    /** Ordered reasoning blocks retained as caller-owned history. */
    readonly reasoning?: readonly SessionReasoning[];
    /** Completed client tool calls emitted alongside this assistant message. */
    readonly toolCalls?: readonly SessionToolCall[];
    /**
     * Ordered, opaque Responses output items. Providers use these to replay commentary,
     * reasoning, and parallel tool calls without flattening or reordering them.
     */
    readonly responseItems?: readonly string[];
}

export interface SessionToolCall {
    readonly callId: string;
    readonly name: string;
    readonly namespace?: string;
    readonly arguments: string;
    /** The provider stopped before this call became executable. */
    readonly incomplete?: boolean;
    /** Opaque provider metadata persisted with this tool call. */
    readonly vendor?: any;
}

export interface SessionToolResultMessage {
    readonly role: "tool";
    readonly callId: string;
    readonly content: string;
    /** Whether the caller reported that the tool invocation failed. */
    readonly isError?: boolean;
    /** Ordered multimodal content. When present, providers use this instead of content. */
    readonly input?: SessionInputContent;
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
