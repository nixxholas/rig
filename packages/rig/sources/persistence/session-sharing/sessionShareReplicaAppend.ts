import { and, eq } from "drizzle-orm";

import { sessionShareReplicaEntries, sessionShareReplicas } from "../database/schema.js";
import { inTx } from "../inTx.js";
import type { TX } from "../Transaction.js";

export function sessionShareReplicaAppend(
    tx: TX,
    input: {
        canonicalJson: string;
        contentHash: string;
        createdAt: number;
        grantEpoch: number;
        grantMemberId: string;
        sequence: number;
        shareEventId: string;
        shareId: string;
    },
): boolean {
    return inTx(tx, (tx) => {
        const replica = tx
            .select()
            .from(sessionShareReplicas)
            .where(eq(sessionShareReplicas.shareId, input.shareId))
            .get();
        if (
            replica === undefined ||
            replica.state !== "active" ||
            replica.shareMemberId !== input.grantMemberId ||
            replica.grantEpoch !== input.grantEpoch
        ) {
            throw new Error("The replica event does not belong to the current active grant.");
        }
        const result = tx
            .insert(sessionShareReplicaEntries)
            .values({
                canonicalJson: input.canonicalJson,
                contentHash: input.contentHash,
                createdAtMs: input.createdAt,
                grantEpoch: input.grantEpoch,
                grantMemberId: input.grantMemberId,
                sequence: input.sequence,
                shareEventId: input.shareEventId,
                shareId: input.shareId,
            })
            .onConflictDoNothing({
                target: [
                    sessionShareReplicaEntries.shareId,
                    sessionShareReplicaEntries.shareEventId,
                ],
            })
            .run();
        if (result.changes > 0) {
            tx.update(sessionShareReplicas)
                .set({ updatedAtMs: input.createdAt })
                .where(
                    and(
                        eq(sessionShareReplicas.shareId, input.shareId),
                        eq(sessionShareReplicas.state, "active"),
                    ),
                )
                .run();
        }
        return result.changes > 0;
    });
}
