import { and, eq } from "drizzle-orm";

import { sessionShareReplicaEntries, sessionShareReplicas } from "../database/schema.js";
import { inTx } from "../inTx.js";
import type { TX } from "../Transaction.js";

export function sessionShareReplicaEndCurrentGrant(
    tx: TX,
    input: {
        grantEpoch: number;
        now: number;
        reason: string;
        shareId: string;
        shareMemberId: string;
    },
): boolean {
    return inTx(tx, (tx) => {
        const ended = tx
            .update(sessionShareReplicas)
            .set({
                endedAtMs: input.now,
                endedReason: input.reason,
                state: "ended",
                updatedAtMs: input.now,
            })
            .where(
                and(
                    eq(sessionShareReplicas.shareId, input.shareId),
                    eq(sessionShareReplicas.shareMemberId, input.shareMemberId),
                    eq(sessionShareReplicas.grantEpoch, input.grantEpoch),
                    eq(sessionShareReplicas.state, "active"),
                ),
            )
            .run();
        if (ended.changes === 0) return false;
        tx.delete(sessionShareReplicaEntries)
            .where(
                and(
                    eq(sessionShareReplicaEntries.shareId, input.shareId),
                    eq(sessionShareReplicaEntries.grantMemberId, input.shareMemberId),
                    eq(sessionShareReplicaEntries.grantEpoch, input.grantEpoch),
                ),
            )
            .run();
        return true;
    });
}
