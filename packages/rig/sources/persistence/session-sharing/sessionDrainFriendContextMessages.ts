import { and, desc, eq, inArray } from "drizzle-orm";

import type {
    FriendContextDrainLimits,
    FriendContextDrainResult,
} from "../../session/InMemorySession.js";
import {
    pendingContextMessages,
    sessionShareFriendMessages,
    sessionShareMessageContext,
    sessionShares,
} from "../database/schema.js";
import { inTx } from "../inTx.js";
import { sessionDrainPendingContextMessages } from "../session/sessionDrainPendingContextMessages.js";
import type { TX } from "../Transaction.js";

export function sessionDrainFriendContextMessages(
    tx: TX,
    input: {
        limits: FriendContextDrainLimits;
        now: number;
        runId: string;
        sessionId: string;
    },
): FriendContextDrainResult {
    return inTx(tx, (tx) => {
        const share = tx
            .select({
                includeFriendMessages: sessionShares.includeFriendMessages,
                state: sessionShares.state,
            })
            .from(sessionShares)
            .where(eq(sessionShares.ownerSessionId, input.sessionId))
            .get();
        if (share === undefined || share.state === "stopped" || !share.includeFriendMessages) {
            return { enabled: false, messages: [], omittedCount: 0, omittedMessageIds: [] };
        }
        const pending = tx
            .select({
                byteEstimate: sessionShareMessageContext.byteEstimate,
                messageId: sessionShareMessageContext.messageId,
                position: pendingContextMessages.position,
                tokenEstimate: sessionShareMessageContext.tokenEstimate,
            })
            .from(sessionShareMessageContext)
            .innerJoin(
                sessionShareFriendMessages,
                eq(sessionShareFriendMessages.messageId, sessionShareMessageContext.messageId),
            )
            .innerJoin(
                pendingContextMessages,
                and(
                    eq(pendingContextMessages.messageId, sessionShareMessageContext.messageId),
                    eq(pendingContextMessages.sessionId, input.sessionId),
                ),
            )
            .where(
                and(
                    eq(sessionShareFriendMessages.ownerSessionId, input.sessionId),
                    eq(sessionShareMessageContext.disposition, "pending"),
                ),
            )
            .orderBy(desc(pendingContextMessages.position))
            .all();
        const selectedIds: string[] = [];
        const omitted: { messageId: string; position: number }[] = [];
        let bytes = 0;
        let estimatedTokens = 0;
        let exhausted = false;
        for (const row of pending) {
            const fits =
                !exhausted &&
                selectedIds.length < input.limits.maxMessages &&
                bytes + row.byteEstimate <= input.limits.maxBytes &&
                estimatedTokens + row.tokenEstimate <= input.limits.maxEstimatedTokens;
            if (!fits) {
                exhausted = true;
                omitted.push({ messageId: row.messageId, position: row.position });
                continue;
            }
            selectedIds.push(row.messageId);
            bytes += row.byteEstimate;
            estimatedTokens += row.tokenEstimate;
        }
        const messages = sessionDrainPendingContextMessages(tx, input.sessionId, selectedIds);
        if (selectedIds.length > 0) {
            tx.update(sessionShareMessageContext)
                .set({
                    disposition: "included",
                    includedRunId: input.runId,
                    updatedAtMs: input.now,
                })
                .where(inArray(sessionShareMessageContext.messageId, selectedIds))
                .run();
        }
        const omittedIds = omitted
            .sort((left, right) => left.position - right.position)
            .map((row) => row.messageId);
        if (omittedIds.length > 0) {
            tx.update(sessionShareMessageContext)
                .set({
                    disposition: "overflow",
                    includedRunId: null,
                    updatedAtMs: input.now,
                })
                .where(inArray(sessionShareMessageContext.messageId, omittedIds))
                .run();
            tx.delete(pendingContextMessages)
                .where(
                    and(
                        eq(pendingContextMessages.sessionId, input.sessionId),
                        inArray(pendingContextMessages.messageId, omittedIds),
                    ),
                )
                .run();
        }
        return {
            enabled: true,
            messages,
            omittedCount: omittedIds.length,
            omittedMessageIds: omittedIds,
        };
    });
}
