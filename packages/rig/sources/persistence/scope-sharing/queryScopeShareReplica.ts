import { and, asc, eq, gt, lte } from "drizzle-orm";

import type { ScopeShareSubjectKind } from "../../scope-sharing/projectScopeShareEntry.js";
import { scopeShareReplicaEntries, scopeShareReplicas } from "../database/schema.js";
import type { TX } from "../Transaction.js";
import type {
    ScopeShareReplicaEndedReason,
    ScopeShareReplicaRecord,
    ScopeShareScopeKind,
} from "./types.js";

const ENDED_REASONS = new Set<string>(["revoked", "stopped", "unreadable"]);

/**
 * Whether a stored reason is one this build knows.
 *
 * The column is plain text, so a row written by a newer build could carry a reason
 * this one has never heard of. Dropping it costs a label; passing it through would
 * fail the response schema and take the whole replica list with it.
 */
function isEndedReason(value: string | null): value is ScopeShareReplicaEndedReason {
    return value !== null && ENDED_REASONS.has(value);
}

export function queryScopeShareReplica(
    tx: TX,
    shareId: string,
): ScopeShareReplicaRecord | undefined {
    const row = tx
        .select()
        .from(scopeShareReplicas)
        .where(eq(scopeShareReplicas.shareId, shareId))
        .get();
    return row === undefined
        ? undefined
        : {
              appliedThroughSequence: row.appliedThroughSequence,
              createdAt: row.createdAtMs,
              ...(row.endedAtMs === null ? {} : { endedAt: row.endedAtMs }),
              ...(isEndedReason(row.endedReason) ? { endedReason: row.endedReason } : {}),
              grantEpoch: row.grantEpoch,
              memberCount: row.memberCount,
              murmurPeerId: row.murmurPeerId,
              ownerPeerId: row.ownerPeerId,
              scopeKind: row.scopeKind as ScopeShareScopeKind,
              shareId: row.shareId,
              shareMemberId: row.shareMemberId,
              state: row.state as ScopeShareReplicaRecord["state"],
              title: row.title,
              updatedAt: row.updatedAtMs,
          };
}

export interface ScopeShareReplicaEntryRecord {
    readonly canonicalJson: string;
    readonly contentHash: string;
    readonly createdAt: number;
    readonly grantEpoch: number;
    readonly grantMemberId: string;
    readonly sequence: number;
    readonly shareEventId: string;
    readonly shareId: string;
    readonly subjectId: string;
    readonly subjectKind: ScopeShareSubjectKind;
}

/**
 * A member's replicated entries, up to the contiguous watermark.
 *
 * `subjectId` narrows the read to one session, which is how a member pages the
 * transcript of a single conversation out of the scope's one shared log.
 */
export function queryScopeShareReplicaEntries(
    tx: TX,
    shareId: string,
    options: {
        afterSequence?: number;
        limit?: number;
        subjectId?: string;
        subjectKind?: ScopeShareSubjectKind;
    } = {},
): readonly ScopeShareReplicaEntryRecord[] {
    const replica = tx
        .select({ appliedThroughSequence: scopeShareReplicas.appliedThroughSequence })
        .from(scopeShareReplicas)
        .where(eq(scopeShareReplicas.shareId, shareId))
        .get();
    if (replica === undefined) return [];
    const afterSequence = Math.max(0, options.afterSequence ?? 0);
    const limit = Math.max(1, Math.min(100, options.limit ?? 100));
    return tx
        .select()
        .from(scopeShareReplicaEntries)
        .where(
            and(
                eq(scopeShareReplicaEntries.shareId, shareId),
                gt(scopeShareReplicaEntries.sequence, afterSequence),
                lte(scopeShareReplicaEntries.sequence, replica.appliedThroughSequence),
                ...(options.subjectId === undefined
                    ? []
                    : [eq(scopeShareReplicaEntries.subjectId, options.subjectId)]),
                ...(options.subjectKind === undefined
                    ? []
                    : [eq(scopeShareReplicaEntries.subjectKind, options.subjectKind)]),
            ),
        )
        .orderBy(asc(scopeShareReplicaEntries.sequence))
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
            subjectId: row.subjectId,
            subjectKind: row.subjectKind as ScopeShareSubjectKind,
        }));
}

export function queryScopeShareReplicas(tx: TX): readonly ScopeShareReplicaRecord[] {
    return tx
        .select({ shareId: scopeShareReplicas.shareId })
        .from(scopeShareReplicas)
        .orderBy(asc(scopeShareReplicas.updatedAtMs), asc(scopeShareReplicas.shareId))
        .limit(1_000)
        .all()
        .map((row) => queryScopeShareReplica(tx, row.shareId))
        .filter((replica): replica is ScopeShareReplicaRecord => replica !== undefined);
}
