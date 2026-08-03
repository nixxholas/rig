import { and, eq } from "drizzle-orm";

import { scopeShareReplicaEntries, scopeShareReplicas } from "../database/schema.js";
import { inTx } from "../inTx.js";
import type { TX } from "../Transaction.js";
import type { ScopeShareReplicaEndedReason } from "./types.js";

export function scopeShareReplicaEndCurrentGrant(
    tx: TX,
    input: {
        grantEpoch: number;
        now: number;
        /**
         * Whether the replicated entries go too. A removal retires them; a local read
         * failure does not, since the member legitimately received and verified them.
         */
        pruneEntries: boolean;
        reason: ScopeShareReplicaEndedReason;
        shareId: string;
        shareMemberId: string;
    },
): boolean {
    return inTx(tx, (tx) => {
        const ended = tx
            .update(scopeShareReplicas)
            .set({
                endedAtMs: input.now,
                endedReason: input.reason,
                state: "ended",
                updatedAtMs: input.now,
            })
            .where(
                and(
                    eq(scopeShareReplicas.shareId, input.shareId),
                    eq(scopeShareReplicas.shareMemberId, input.shareMemberId),
                    eq(scopeShareReplicas.grantEpoch, input.grantEpoch),
                    eq(scopeShareReplicas.state, "active"),
                ),
            )
            .run();
        if (ended.changes === 0) return false;
        if (!input.pruneEntries) return true;
        tx.delete(scopeShareReplicaEntries)
            .where(
                and(
                    eq(scopeShareReplicaEntries.shareId, input.shareId),
                    eq(scopeShareReplicaEntries.grantMemberId, input.shareMemberId),
                    eq(scopeShareReplicaEntries.grantEpoch, input.grantEpoch),
                ),
            )
            .run();
        return true;
    });
}
