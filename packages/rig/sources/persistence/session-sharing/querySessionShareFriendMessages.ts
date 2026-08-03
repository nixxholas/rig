import { and, asc, eq } from "drizzle-orm";

import { sessionShareFriendMessages, sessionShareMessageContext } from "../database/schema.js";
import type { TX } from "../Transaction.js";
import type { SessionShareMessageDisposition } from "./types.js";
import type { SessionShareFriendMessageRecord } from "./sessionShareFriendMessageSave.js";

export function querySessionShareFriendMessages(
    tx: TX,
    input: { disposition?: SessionShareMessageDisposition; shareId: string },
): readonly (SessionShareFriendMessageRecord & {
    byteEstimate: number;
    disposition: SessionShareMessageDisposition;
    includedRunId?: string;
    tokenEstimate: number;
})[] {
    return tx
        .select({
            byteEstimate: sessionShareMessageContext.byteEstimate,
            clientMessageId: sessionShareFriendMessages.clientMessageId,
            createdAtMs: sessionShareFriendMessages.createdAtMs,
            disposition: sessionShareMessageContext.disposition,
            grantEpoch: sessionShareFriendMessages.grantEpoch,
            includedRunId: sessionShareMessageContext.includedRunId,
            messageId: sessionShareFriendMessages.messageId,
            ownerPosition: sessionShareFriendMessages.ownerPosition,
            ownerSessionId: sessionShareFriendMessages.ownerSessionId,
            shareId: sessionShareFriendMessages.shareId,
            shareMemberId: sessionShareFriendMessages.shareMemberId,
            tokenEstimate: sessionShareMessageContext.tokenEstimate,
        })
        .from(sessionShareFriendMessages)
        .innerJoin(
            sessionShareMessageContext,
            eq(sessionShareMessageContext.messageId, sessionShareFriendMessages.messageId),
        )
        .where(
            input.disposition === undefined
                ? eq(sessionShareFriendMessages.shareId, input.shareId)
                : and(
                      eq(sessionShareFriendMessages.shareId, input.shareId),
                      eq(sessionShareMessageContext.disposition, input.disposition),
                  ),
        )
        .orderBy(asc(sessionShareFriendMessages.ownerPosition))
        .all()
        .map((row) => ({
            byteEstimate: row.byteEstimate,
            clientMessageId: row.clientMessageId,
            createdAt: row.createdAtMs,
            disposition: row.disposition as SessionShareMessageDisposition,
            grantEpoch: row.grantEpoch,
            ...(row.includedRunId === null ? {} : { includedRunId: row.includedRunId }),
            messageId: row.messageId,
            ownerPosition: row.ownerPosition,
            ownerSessionId: row.ownerSessionId,
            shareId: row.shareId,
            shareMemberId: row.shareMemberId,
            tokenEstimate: row.tokenEstimate,
        }));
}
