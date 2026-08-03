import { createHash } from "node:crypto";

import { and, eq, or, sql } from "drizzle-orm";
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
        grantShareId: string;
        sequence: number;
        shareEventId: string;
        shareId: string;
    },
): boolean {
    return inTx(tx, (tx) => {
        if (input.shareId !== input.grantShareId) {
            throw new Error("The replica entry share does not match its grant.");
        }
        const expectedHash = createHash("sha256").update(input.canonicalJson).digest("base64url");
        if (input.contentHash !== expectedHash) {
            throw new Error("The replica entry content hash is invalid.");
        }
        const replica = tx
            .select()
            .from(sessionShareReplicas)
            .where(eq(sessionShareReplicas.shareId, input.grantShareId))
            .get();
        if (
            replica === undefined ||
            replica.state !== "active" ||
            replica.shareMemberId !== input.grantMemberId ||
            replica.grantEpoch !== input.grantEpoch
        ) {
            throw new Error("The replica event does not belong to the current active grant.");
        }
        const conflicts = tx
            .select()
            .from(sessionShareReplicaEntries)
            .where(
                and(
                    eq(sessionShareReplicaEntries.shareId, input.shareId),
                    or(
                        eq(sessionShareReplicaEntries.shareEventId, input.shareEventId),
                        eq(sessionShareReplicaEntries.sequence, input.sequence),
                    ),
                ),
            )
            .all();
        if (conflicts.length > 0) {
            const duplicate = conflicts.some(
                (entry) =>
                    entry.canonicalJson === input.canonicalJson &&
                    entry.contentHash === input.contentHash &&
                    entry.createdAtMs === input.createdAt &&
                    entry.grantEpoch === input.grantEpoch &&
                    entry.grantMemberId === input.grantMemberId &&
                    entry.sequence === input.sequence &&
                    entry.shareEventId === input.shareEventId,
            );
            if (duplicate && conflicts.length === 1) return false;
            throw new Error("The replica entry conflicts with an existing event or sequence.");
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
            .run();
        if (result.changes > 0) {
            const watermark = tx.get<{ sequence: number }>(sql`
                WITH ordered AS (
                    SELECT
                        sequence,
                        ROW_NUMBER() OVER (ORDER BY sequence) AS ordinal
                    FROM session_share_replica_entries
                    WHERE share_id = ${input.shareId}
                      AND sequence > ${replica.appliedThroughSequence}
                ),
                first_gap AS (
                    SELECT MIN(ordinal) AS ordinal
                    FROM ordered
                    WHERE sequence != ${replica.appliedThroughSequence} + ordinal
                ),
                totals AS (
                    SELECT COUNT(*) AS count FROM ordered
                )
                SELECT CASE
                    WHEN totals.count = 0 THEN ${replica.appliedThroughSequence}
                    WHEN first_gap.ordinal IS NULL
                        THEN ${replica.appliedThroughSequence} + totals.count
                    ELSE ${replica.appliedThroughSequence} + first_gap.ordinal - 1
                END AS sequence
                FROM totals, first_gap
            `);
            tx.update(sessionShareReplicas)
                .set({
                    appliedThroughSequence: watermark?.sequence ?? replica.appliedThroughSequence,
                    updatedAtMs: sql`MAX(${sessionShareReplicas.updatedAtMs}, ${input.createdAt})`,
                })
                .where(
                    and(
                        eq(sessionShareReplicas.shareId, input.shareId),
                        eq(sessionShareReplicas.shareMemberId, input.grantMemberId),
                        eq(sessionShareReplicas.grantEpoch, input.grantEpoch),
                        eq(sessionShareReplicas.state, "active"),
                    ),
                )
                .run();
        }
        return result.changes > 0;
    });
}
