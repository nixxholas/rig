import type { Context } from "@steve.kite/stdlib";

import type { ProtocolSession, SessionEvent } from "../protocol/index.js";
import type { Message, UserMessage } from "./types.js";
import type { RigAgentConfiguration } from "./RigProtocolFeature.js";

export interface RigProtocolUserMessageInput {
    readonly delivery: "run" | "steer";
    readonly displayText: string;
    readonly message: UserMessage;
    readonly mutationId?: string;
    readonly runId: string;
    readonly submissionFingerprint?: string;
}

/**
 * Rig's stateless external read model for an Agent Base conversation.
 *
 * Implementations persist protocol events and snapshots by conversation ID. They do not own an
 * agent loop, feature state, compute, or a cache of live session objects.
 */
export interface RigProtocolProjection {
    afterCommit(
        ctx: Context,
        callback: (postCommitCtx: Context) => void | Promise<void>,
    ): Promise<void>;
    messageSubmission(
        ctx: Context,
        conversationId: string,
        messageId: string,
    ): Promise<Extract<SessionEvent, { type: "message_submitted" }> | undefined>;
    projectAgentConfiguration(
        ctx: Context,
        conversationId: string,
        configuration: RigAgentConfiguration,
    ): Promise<ProtocolSession>;
    projectAgentMessage(
        ctx: Context,
        conversationId: string,
        runId: string,
        message: Message,
    ): Promise<Extract<SessionEvent, { type: "agent_message" }>>;
    projectProtocolEvent<TEvent extends SessionEvent>(
        ctx: Context,
        conversationId: string,
        event: TEvent,
    ): Promise<TEvent>;
    projectUserMessage(
        ctx: Context,
        conversationId: string,
        input: RigProtocolUserMessageInput,
    ): Promise<Extract<SessionEvent, { type: "message_submitted" }>>;
    publishLive(ctx: Context, event: SessionEvent): void;
    readSnapshot(ctx: Context, conversationId: string): Promise<ProtocolSession | undefined>;
}
