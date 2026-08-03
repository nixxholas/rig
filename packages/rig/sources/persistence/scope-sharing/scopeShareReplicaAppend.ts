import { createHash } from "node:crypto";

import { and, eq, or, sql } from "drizzle-orm";
import { Value } from "@sinclair/typebox/value";

import {
    scopeShareProjectionSchema,
    scopeShareProjectionSubject,
} from "../../scope-sharing/projectScopeShareEntry.js";
import { scopeShareReplicaEntries, scopeShareReplicas } from "../database/schema.js";
import { inTx } from "../inTx.js";
import type { TX } from "../Transaction.js";

/**
 * Apply one entry a member received for a scope it replicates.
 *
 * The entry arrives opaque, so its subject is read back out of the canonical JSON
 * here: a member has to be able to page one session's transcript out of the one
 * log the whole scope travels in, and that is the only place the tag is available
 * without re-parsing every row on every read.
 */
export function scopeShareReplicaAppend(
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
        const subject = decodeSubject(input.canonicalJson);
        const replica = tx
            .select()
            .from(scopeShareReplicas)
            .where(eq(scopeShareReplicas.shareId, input.grantShareId))
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
            .from(scopeShareReplicaEntries)
            .where(
                and(
                    eq(scopeShareReplicaEntries.shareId, input.shareId),
                    or(
                        eq(scopeShareReplicaEntries.shareEventId, input.shareEventId),
                        eq(scopeShareReplicaEntries.sequence, input.sequence),
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
            .insert(scopeShareReplicaEntries)
            .values({
                canonicalJson: input.canonicalJson,
                contentHash: input.contentHash,
                createdAtMs: input.createdAt,
                grantEpoch: input.grantEpoch,
                grantMemberId: input.grantMemberId,
                sequence: input.sequence,
                shareEventId: input.shareEventId,
                shareId: input.shareId,
                subjectId: subject.subjectId,
                subjectKind: subject.subjectKind,
            })
            .run();
        if (result.changes > 0) {
            const watermark = tx.get<{ sequence: number }>(sql`
                WITH ordered AS (
                    SELECT
                        sequence,
                        ROW_NUMBER() OVER (ORDER BY sequence) AS ordinal
                    FROM scope_share_replica_entries
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
            tx.update(scopeShareReplicas)
                .set({
                    appliedThroughSequence: watermark?.sequence ?? replica.appliedThroughSequence,
                    updatedAtMs: sql`MAX(${scopeShareReplicas.updatedAtMs}, ${input.createdAt})`,
                })
                .where(
                    and(
                        eq(scopeShareReplicas.shareId, input.shareId),
                        eq(scopeShareReplicas.shareMemberId, input.grantMemberId),
                        eq(scopeShareReplicas.grantEpoch, input.grantEpoch),
                        eq(scopeShareReplicas.state, "active"),
                    ),
                )
                .run();
        }
        return result.changes > 0;
    });
}

function decodeSubject(canonicalJson: string): { subjectId: string; subjectKind: string } {
    let parsed: unknown;
    try {
        parsed = JSON.parse(canonicalJson);
    } catch {
        throw new Error("The replica entry is not a shared scope projection.");
    }
    if (!Value.Check(scopeShareProjectionSchema, parsed)) {
        throw new Error("The replica entry is not a shared scope projection.");
    }
    return scopeShareProjectionSubject(parsed);
}
