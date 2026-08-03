import { and, eq } from "drizzle-orm";

import {
    sessionShareFriendMessages,
    sessionShareGrants,
    sessionShareMembers,
    sessionShareMessageContext,
    sessionShares,
} from "../database/schema.js";
import { inTx } from "../inTx.js";
import { ShareUnauthorizedPostError } from "../../sharing/ShareUnauthorizedPostError.js";
import type { TX } from "../Transaction.js";

export interface SessionShareFriendMessageRecord {
    shareId: string;
    shareMemberId: string;
    grantEpoch: number;
    clientMessageId: string;
    messageId: string;
    ownerSessionId: string;
    ownerPosition: number;
    createdAt: number;
}

export function sessionShareFriendMessageSave(
    tx: TX,
    input: SessionShareFriendMessageRecord & {
        byteEstimate: number;
        displayName: string;
        murmurPeerId: string;
        tokenEstimate: number;
    },
): SessionShareFriendMessageRecord {
    return inTx(tx, (tx) => {
        const duplicate = tx
            .select()
            .from(sessionShareFriendMessages)
            .where(
                and(
                    eq(sessionShareFriendMessages.shareId, input.shareId),
                    eq(sessionShareFriendMessages.shareMemberId, input.shareMemberId),
                    eq(sessionShareFriendMessages.grantEpoch, input.grantEpoch),
                    eq(sessionShareFriendMessages.clientMessageId, input.clientMessageId),
                ),
            )
            .get();
        if (duplicate !== undefined) return friendRecord(duplicate);
        const authority = tx
            .select({
                grantState: sessionShareGrants.state,
                memberEpoch: sessionShareMembers.currentGrantEpoch,
                memberDisplayName: sessionShareMembers.displayName,
                memberPeerId: sessionShareMembers.murmurPeerId,
                memberState: sessionShareMembers.state,
                memberShareId: sessionShareMembers.shareId,
                ownerSessionId: sessionShares.ownerSessionId,
                shareState: sessionShares.state,
            })
            .from(sessionShareMembers)
            .innerJoin(
                sessionShareGrants,
                and(
                    eq(sessionShareGrants.shareMemberId, sessionShareMembers.shareMemberId),
                    eq(sessionShareGrants.grantEpoch, input.grantEpoch),
                ),
            )
            .innerJoin(sessionShares, eq(sessionShares.shareId, sessionShareMembers.shareId))
            .where(eq(sessionShareMembers.shareMemberId, input.shareMemberId))
            .get();
        if (
            authority === undefined ||
            authority.memberShareId !== input.shareId ||
            authority.memberEpoch !== input.grantEpoch ||
            authority.memberDisplayName !== input.displayName ||
            authority.memberPeerId !== input.murmurPeerId ||
            authority.ownerSessionId !== input.ownerSessionId ||
            authority.shareState !== "active" ||
            authority.memberState !== "active" ||
            authority.grantState !== "active"
        ) {
            throw new ShareUnauthorizedPostError(
                "The current share grant does not accept friend messages.",
            );
        }
        tx.insert(sessionShareFriendMessages)
            .values({
                clientMessageId: input.clientMessageId,
                createdAtMs: input.createdAt,
                grantEpoch: input.grantEpoch,
                messageId: input.messageId,
                ownerPosition: input.ownerPosition,
                ownerSessionId: input.ownerSessionId,
                shareId: input.shareId,
                shareMemberId: input.shareMemberId,
            })
            .run();
        tx.insert(sessionShareMessageContext)
            .values({
                byteEstimate: input.byteEstimate,
                disposition: "pending",
                grantEpoch: input.grantEpoch,
                messageId: input.messageId,
                shareId: input.shareId,
                shareMemberId: input.shareMemberId,
                tokenEstimate: input.tokenEstimate,
                updatedAtMs: input.createdAt,
            })
            .run();
        return {
            clientMessageId: input.clientMessageId,
            createdAt: input.createdAt,
            grantEpoch: input.grantEpoch,
            messageId: input.messageId,
            ownerPosition: input.ownerPosition,
            ownerSessionId: input.ownerSessionId,
            shareId: input.shareId,
            shareMemberId: input.shareMemberId,
        };
    });
}

function friendRecord(
    row: typeof sessionShareFriendMessages.$inferSelect,
): SessionShareFriendMessageRecord {
    return {
        clientMessageId: row.clientMessageId,
        createdAt: row.createdAtMs,
        grantEpoch: row.grantEpoch,
        messageId: row.messageId,
        ownerPosition: row.ownerPosition,
        ownerSessionId: row.ownerSessionId,
        shareId: row.shareId,
        shareMemberId: row.shareMemberId,
    };
}
