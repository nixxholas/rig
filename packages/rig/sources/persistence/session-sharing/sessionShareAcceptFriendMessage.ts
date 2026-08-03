import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { Value } from "@sinclair/typebox/value";

import type { UserMessage } from "../../agent/types.js";
import { createEventIdFactory } from "../../protocol/createEventIdFactory.js";
import type { SessionEvent } from "../../protocol/index.js";
import type {
    SessionShareAcceptedFriendMessage,
    SessionShareDuplicateFriendMessage,
} from "../../session-sharing/SessionShareService.js";
import type { SessionShareTransportMemberPost } from "../../session-sharing/SessionShareTransport.js";
import { friendAuthorSchema } from "../../session-sharing/FriendAuthor.js";
import {
    pendingContextMessages,
    sessionMessages,
    sessionShareFriendMessages,
    sessionShareMessageContext,
    sessionShares,
    sessions,
} from "../database/schema.js";
import { inTx } from "../inTx.js";
import type { TX } from "../Transaction.js";
import { sessionSavePendingContextMessage } from "../session/sessionSavePendingContextMessage.js";
import { sessionAppendEvent } from "../session/sessionAppendEvent.js";
import { sessionShareFriendMessageSave } from "./sessionShareFriendMessageSave.js";

const DEFAULT_BACKLOG_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_BACKLOG_MAX_MESSAGES = 10_000;

export function sessionShareAcceptFriendMessage(
    tx: TX,
    input: {
        backlogLimits?: { maxBytes: number; maxMessages: number };
        message: UserMessage;
        now: number;
        post: SessionShareTransportMemberPost;
        senderPeerId: string;
    },
): SessionShareAcceptedFriendMessage | SessionShareDuplicateFriendMessage {
    const author = input.message.friendAuthor;
    if (
        input.message.role !== "user" ||
        input.message.contextOnly !== true ||
        !Value.Check(friendAuthorSchema, author) ||
        author.shareId !== input.post.grant.shareId ||
        author.shareMemberId !== input.post.grant.shareMemberId ||
        author.grantEpoch !== input.post.grant.grantEpoch ||
        author.murmurPeerId !== input.senderPeerId
    ) {
        throw new Error("The friend message authorship is invalid.");
    }
    return inTx(tx, (tx) => {
        const duplicate = tx
            .select({
                messageId: sessionShareFriendMessages.messageId,
                messageJson: sessionMessages.messageJson,
                ownerSessionId: sessionShareFriendMessages.ownerSessionId,
            })
            .from(sessionShareFriendMessages)
            .innerJoin(
                sessionMessages,
                and(
                    eq(sessionMessages.sessionId, sessionShareFriendMessages.ownerSessionId),
                    eq(sessionMessages.messageId, sessionShareFriendMessages.messageId),
                ),
            )
            .where(
                and(
                    eq(sessionShareFriendMessages.shareId, input.post.grant.shareId),
                    eq(sessionShareFriendMessages.shareMemberId, input.post.grant.shareMemberId),
                    eq(sessionShareFriendMessages.grantEpoch, input.post.grant.grantEpoch),
                    eq(sessionShareFriendMessages.clientMessageId, input.post.clientMessageId),
                ),
            )
            .get();
        if (duplicate !== undefined) {
            return {
                messageId: duplicate.messageId,
                ownerSessionId: duplicate.ownerSessionId,
                status: "duplicate",
            };
        }
        const ownerSessionId = tx
            .select({ ownerSessionId: sessionShares.ownerSessionId })
            .from(sessionShares)
            .where(eq(sessionShares.shareId, input.post.grant.shareId))
            .get()?.ownerSessionId;
        if (ownerSessionId === undefined) throw new Error("The session share does not exist.");
        const position =
            (tx.get<{ position: number }>(sql`
                SELECT COALESCE(MAX(position), -1) AS position
                FROM session_messages
                WHERE session_id = ${ownerSessionId}
            `)?.position ?? -1) + 1;
        sessionSavePendingContextMessage(
            tx,
            ownerSessionId,
            {
                anchorRunId: `friend:${input.message.id}`,
                createdAt: input.now,
                message: input.message,
                position,
            },
            input.now,
        );
        sessionShareFriendMessageSave(tx, {
            byteEstimate: Buffer.byteLength(input.post.text, "utf8"),
            clientMessageId: input.post.clientMessageId,
            createdAt: input.now,
            displayName: input.message.friendAuthor?.displayName ?? "",
            grantEpoch: input.post.grant.grantEpoch,
            messageId: input.message.id,
            murmurPeerId: input.senderPeerId,
            ownerPosition: position,
            ownerSessionId,
            shareId: input.post.grant.shareId,
            shareMemberId: input.post.grant.shareMemberId,
            tokenEstimate: Math.ceil(input.post.text.length / 4),
        });
        const event: Extract<SessionEvent, { type: "message_submitted" }> = {
            createdAt: input.now,
            data: {
                delivery: "context",
                displayText: input.post.text,
                message: input.message,
                runId: `friend:${input.message.id}`,
            },
            id: createEventIdFactory({ now: () => input.now })(),
            sessionId: ownerSessionId,
            type: "message_submitted",
        };
        sessionAppendEvent(
            tx,
            event,
            { messageId: input.message.id, runId: event.data.runId },
            input.now,
        );
        const overflowedMessageIds = boundPendingFriendBacklog(tx, {
            maxBytes: input.backlogLimits?.maxBytes ?? DEFAULT_BACKLOG_MAX_BYTES,
            maxMessages: input.backlogLimits?.maxMessages ?? DEFAULT_BACKLOG_MAX_MESSAGES,
            now: input.now,
            ownerSessionId,
            shareId: input.post.grant.shareId,
        });
        tx.update(sessions)
            .set({
                unreadReason: sql`CASE WHEN ${sessions.trackUnread} = 1 THEN 'friend_message' ELSE ${sessions.unreadReason} END`,
                unreadSinceMs: sql`CASE
                    WHEN ${sessions.trackUnread} = 1 AND ${sessions.unreadSinceMs} IS NULL
                        THEN ${input.now}
                    ELSE ${sessions.unreadSinceMs}
                END`,
                updatedAtMs: input.now,
            })
            .where(eq(sessions.id, ownerSessionId))
            .run();
        return {
            createdAt: input.now,
            event,
            message: input.message,
            ownerSessionId,
            overflowedMessageIds,
            position,
            status: "accepted",
        };
    });
}

function boundPendingFriendBacklog(
    tx: TX,
    input: {
        maxBytes: number;
        maxMessages: number;
        now: number;
        ownerSessionId: string;
        shareId: string;
    },
): readonly string[] {
    const pending = tx
        .select({
            byteEstimate: sessionShareMessageContext.byteEstimate,
            messageId: sessionShareMessageContext.messageId,
        })
        .from(sessionShareMessageContext)
        .innerJoin(
            sessionShareFriendMessages,
            eq(sessionShareFriendMessages.messageId, sessionShareMessageContext.messageId),
        )
        .where(
            and(
                eq(sessionShareMessageContext.shareId, input.shareId),
                eq(sessionShareMessageContext.disposition, "pending"),
            ),
        )
        .orderBy(
            desc(sessionShareFriendMessages.ownerPosition),
            desc(sessionShareFriendMessages.messageId),
        )
        .all();
    let retainedBytes = 0;
    let retainedMessages = 0;
    const overflowed: string[] = [];
    for (const row of pending) {
        if (
            retainedMessages < input.maxMessages &&
            retainedBytes + row.byteEstimate <= input.maxBytes
        ) {
            retainedMessages += 1;
            retainedBytes += row.byteEstimate;
        } else {
            overflowed.push(row.messageId);
        }
    }
    if (overflowed.length === 0) return [];
    tx.update(sessionShareMessageContext)
        .set({ disposition: "overflow", includedRunId: null, updatedAtMs: input.now })
        .where(inArray(sessionShareMessageContext.messageId, overflowed))
        .run();
    tx.delete(pendingContextMessages)
        .where(
            and(
                eq(pendingContextMessages.sessionId, input.ownerSessionId),
                inArray(pendingContextMessages.messageId, overflowed),
            ),
        )
        .run();
    return overflowed;
}
