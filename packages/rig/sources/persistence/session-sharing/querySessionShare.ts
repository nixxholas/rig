import { asc, desc, eq, sql } from "drizzle-orm";

import { sessionShareMembers, sessionShares } from "../database/schema.js";
import type { TX } from "../Transaction.js";
import type { SessionShareMemberRecord, SessionShareRecord } from "./types.js";

export function querySessionShare(tx: TX, shareId: string): SessionShareRecord | undefined {
    const row = tx.select().from(sessionShares).where(eq(sessionShares.shareId, shareId)).get();
    return row === undefined
        ? undefined
        : {
              createdAt: row.createdAtMs,
              includeFriendMessages: row.includeFriendMessages,
              nextShareSequence: row.nextShareSequence,
              outboxBytes: row.outboxBytes,
              outboxCount: row.outboxCount,
              ownerPeerId: row.ownerPeerId,
              ownerSessionId: row.ownerSessionId,
              publishedMessagePosition: row.publishedMessagePosition,
              publishedEventSeq: row.publishedEventSeq,
              shareId: row.shareId,
              ...(row.snapshotThroughEventId === null
                  ? {}
                  : { snapshotThroughEventId: row.snapshotThroughEventId }),
              ...(row.snapshotThroughPosition === null
                  ? {}
                  : { snapshotThroughPosition: row.snapshotThroughPosition }),
              state: row.state as SessionShareRecord["state"],
              ...(row.stoppedAtMs === null ? {} : { stoppedAt: row.stoppedAtMs }),
              updatedAt: row.updatedAtMs,
          };
}

export function querySessionShareByOwnerSession(
    tx: TX,
    ownerSessionId: string,
): SessionShareRecord | undefined {
    const shareId = tx
        .select({ shareId: sessionShares.shareId })
        .from(sessionShares)
        .where(eq(sessionShares.ownerSessionId, ownerSessionId))
        .orderBy(
            desc(sql`${sessionShares.state} <> 'stopped'`),
            desc(sessionShares.createdAtMs),
            desc(sessionShares.shareId),
        )
        .get()?.shareId;
    return shareId === undefined ? undefined : querySessionShare(tx, shareId);
}

export function querySessionShareMembers(
    tx: TX,
    shareId: string,
): readonly SessionShareMemberRecord[] {
    return tx
        .select()
        .from(sessionShareMembers)
        .where(eq(sessionShareMembers.shareId, shareId))
        .orderBy(asc(sessionShareMembers.createdAtMs), asc(sessionShareMembers.shareMemberId))
        .all()
        .map((row) => ({
            createdAt: row.createdAtMs,
            currentGrantEpoch: row.currentGrantEpoch,
            displayName: row.displayName,
            murmurPeerId: row.murmurPeerId,
            shareId: row.shareId,
            shareMemberId: row.shareMemberId,
            state: row.state as SessionShareMemberRecord["state"],
            updatedAt: row.updatedAtMs,
        }));
}
