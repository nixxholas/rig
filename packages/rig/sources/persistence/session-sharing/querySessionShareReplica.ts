import { and, asc, eq, gt, lte } from "drizzle-orm";

import { sessionShareReplicaEntries, sessionShareReplicas } from "../database/schema.js";
import type { TX } from "../Transaction.js";
import type { SessionShareReplicaEndedReason, SessionShareReplicaRecord } from "./types.js";

const ENDED_REASONS = new Set<string>(["revoked", "stopped", "unreadable"]);

/**
 * Whether a stored reason is one this build knows.
 *
 * The column is plain text, so a row written by a newer build could carry a reason this
 * one has never heard of. Dropping it costs a label; passing it through would fail the
 * response schema and take the whole replica list with it.
 */
function isEndedReason(value: string | null): value is SessionShareReplicaEndedReason {
    return value !== null && ENDED_REASONS.has(value);
}

export function querySessionShareReplica(
    tx: TX,
    shareId: string,
): SessionShareReplicaRecord | undefined {
    const row = tx
        .select()
        .from(sessionShareReplicas)
        .where(eq(sessionShareReplicas.shareId, shareId))
        .get();
    return row === undefined
        ? undefined
        : {
              createdAt: row.createdAtMs,
              ...(row.endedAtMs === null ? {} : { endedAt: row.endedAtMs }),
              ...(isEndedReason(row.endedReason) ? { endedReason: row.endedReason } : {}),
              appliedThroughSequence: row.appliedThroughSequence,
              grantEpoch: row.grantEpoch,
              memberCount: row.memberCount,
              murmurPeerId: row.murmurPeerId,
              ownerPeerId: row.ownerPeerId,
              shareId: row.shareId,
              shareMemberId: row.shareMemberId,
              state: row.state as SessionShareReplicaRecord["state"],
              title: row.title,
              updatedAt: row.updatedAtMs,
          };
}

export function querySessionShareReplicaEntries(
    tx: TX,
    shareId: string,
    options: { afterSequence?: number; limit?: number } = {},
) {
    const replica = tx
        .select({ appliedThroughSequence: sessionShareReplicas.appliedThroughSequence })
        .from(sessionShareReplicas)
        .where(eq(sessionShareReplicas.shareId, shareId))
        .get();
    if (replica === undefined) return [];
    const afterSequence = Math.max(0, options.afterSequence ?? 0);
    const limit = Math.max(1, Math.min(100, options.limit ?? 100));
    return tx
        .select()
        .from(sessionShareReplicaEntries)
        .where(
            and(
                eq(sessionShareReplicaEntries.shareId, shareId),
                gt(sessionShareReplicaEntries.sequence, afterSequence),
                lte(sessionShareReplicaEntries.sequence, replica.appliedThroughSequence),
            ),
        )
        .orderBy(asc(sessionShareReplicaEntries.sequence))
        .limit(limit)
        .all()
        .map((row) => ({
            canonicalJson: row.canonicalJson,
            contentHash: row.contentHash,
            createdAt: row.createdAtMs,
            grantEpoch: row.grantEpoch,
            grantMemberId: row.grantMemberId,
            sequence: row.sequence,
            shareEventId: row.shareEventId,
            shareId: row.shareId,
        }));
}

export function querySessionShareReplicas(tx: TX): readonly SessionShareReplicaRecord[] {
    return tx
        .select({ shareId: sessionShareReplicas.shareId })
        .from(sessionShareReplicas)
        .orderBy(asc(sessionShareReplicas.updatedAtMs), asc(sessionShareReplicas.shareId))
        .limit(1_000)
        .all()
        .map((row) => querySessionShareReplica(tx, row.shareId))
        .filter((replica): replica is SessionShareReplicaRecord => replica !== undefined);
}
