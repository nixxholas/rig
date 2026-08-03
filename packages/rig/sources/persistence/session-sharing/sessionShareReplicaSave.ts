import { eq, sql } from "drizzle-orm";

import { sessionShareReplicaEntries, sessionShareReplicas } from "../database/schema.js";
import { inTx } from "../inTx.js";
import type { TX } from "../Transaction.js";
import type { SessionShareReplicaRecord } from "./types.js";

export function sessionShareReplicaSave(tx: TX, replica: SessionShareReplicaRecord): void {
    inTx(tx, (tx) => {
        const existing = tx
            .select({ grantEpoch: sessionShareReplicas.grantEpoch })
            .from(sessionShareReplicas)
            .where(eq(sessionShareReplicas.shareId, replica.shareId))
            .get();
        tx.insert(sessionShareReplicas)
            .values({
                createdAtMs: replica.createdAt,
                endedAtMs: replica.endedAt ?? null,
                endedReason: replica.endedReason ?? null,
                grantEpoch: replica.grantEpoch,
                memberCount: replica.memberCount,
                murmurPeerId: replica.murmurPeerId,
                ownerPeerId: replica.ownerPeerId,
                shareId: replica.shareId,
                shareMemberId: replica.shareMemberId,
                state: replica.state,
                title: replica.title,
                updatedAtMs: replica.updatedAt,
            })
            .onConflictDoUpdate({
                set: {
                    endedAtMs: sql`excluded.ended_at_ms`,
                    endedReason: sql`excluded.ended_reason`,
                    grantEpoch: sql`excluded.grant_epoch`,
                    memberCount: sql`excluded.member_count`,
                    murmurPeerId: sql`excluded.murmur_peer_id`,
                    ownerPeerId: sql`excluded.owner_peer_id`,
                    shareMemberId: sql`excluded.share_member_id`,
                    state: sql`excluded.state`,
                    title: sql`excluded.title`,
                    updatedAtMs: sql`excluded.updated_at_ms`,
                },
                setWhere: sql`
                excluded.grant_epoch > ${sessionShareReplicas.grantEpoch}
                OR (
                    excluded.grant_epoch = ${sessionShareReplicas.grantEpoch}
                    AND ${sessionShareReplicas.state} = 'active'
                )
            `,
                target: sessionShareReplicas.shareId,
            })
            .run();
        if (existing !== undefined && replica.grantEpoch > existing.grantEpoch) {
            tx.delete(sessionShareReplicaEntries)
                .where(eq(sessionShareReplicaEntries.shareId, replica.shareId))
                .run();
        }
    });
}
