import { eq, sql } from "drizzle-orm";

import { scopeShareReplicaEntries, scopeShareReplicas } from "../database/schema.js";
import { inTx } from "../inTx.js";
import type { TX } from "../Transaction.js";
import type { ScopeShareReplicaRecord } from "./types.js";

/**
 * Record what this daemon knows about a scope it replicates.
 *
 * A newer grant epoch replaces an older one and takes the entries of the old one
 * with it: a re-invited member is a new group whose sequences start again, so
 * keeping the previous rows would collide with the ones about to arrive.
 */
export function scopeShareReplicaSave(
    tx: TX,
    replica: Omit<ScopeShareReplicaRecord, "appliedThroughSequence">,
): void {
    inTx(tx, (tx) => {
        const existing = tx
            .select({ grantEpoch: scopeShareReplicas.grantEpoch })
            .from(scopeShareReplicas)
            .where(eq(scopeShareReplicas.shareId, replica.shareId))
            .get();
        tx.insert(scopeShareReplicas)
            .values({
                appliedThroughSequence: 0,
                createdAtMs: replica.createdAt,
                endedAtMs: replica.endedAt ?? null,
                endedReason: replica.endedReason ?? null,
                grantEpoch: replica.grantEpoch,
                memberCount: replica.memberCount,
                murmurPeerId: replica.murmurPeerId,
                ownerPeerId: replica.ownerPeerId,
                scopeKind: replica.scopeKind,
                shareId: replica.shareId,
                shareMemberId: replica.shareMemberId,
                state: replica.state,
                title: replica.title,
                updatedAtMs: replica.updatedAt,
            })
            .onConflictDoUpdate({
                set: {
                    appliedThroughSequence: sql`
                        CASE
                            WHEN excluded.grant_epoch > ${scopeShareReplicas.grantEpoch} THEN 0
                            ELSE ${scopeShareReplicas.appliedThroughSequence}
                        END
                    `,
                    endedAtMs: sql`excluded.ended_at_ms`,
                    endedReason: sql`excluded.ended_reason`,
                    grantEpoch: sql`excluded.grant_epoch`,
                    memberCount: sql`excluded.member_count`,
                    murmurPeerId: sql`excluded.murmur_peer_id`,
                    ownerPeerId: sql`excluded.owner_peer_id`,
                    scopeKind: sql`excluded.scope_kind`,
                    shareMemberId: sql`excluded.share_member_id`,
                    state: sql`excluded.state`,
                    title: sql`excluded.title`,
                    updatedAtMs: sql`excluded.updated_at_ms`,
                },
                setWhere: sql`
                    excluded.grant_epoch > ${scopeShareReplicas.grantEpoch}
                    OR (
                        excluded.grant_epoch = ${scopeShareReplicas.grantEpoch}
                        AND ${scopeShareReplicas.state} = 'active'
                    )
                `,
                target: scopeShareReplicas.shareId,
            })
            .run();
        if (existing !== undefined && replica.grantEpoch > existing.grantEpoch) {
            tx.delete(scopeShareReplicaEntries)
                .where(eq(scopeShareReplicaEntries.shareId, replica.shareId))
                .run();
        }
    });
}
