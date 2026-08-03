import { and, asc, eq, ne } from "drizzle-orm";

import { scopeShareMembers, scopeShares } from "../database/schema.js";
import type { TX } from "../Transaction.js";
import type { ScopeShareMemberRecord, ScopeShareRecord, ScopeShareScopeKind } from "./types.js";

export function queryScopeShare(tx: TX, shareId: string): ScopeShareRecord | undefined {
    const row = tx.select().from(scopeShares).where(eq(scopeShares.shareId, shareId)).get();
    return row === undefined ? undefined : shareRecord(row);
}

/** The one live share of a scope, which the unique index guarantees is at most one. */
export function queryScopeShareForScope(
    tx: TX,
    scope: { scopeId: string; scopeKind: ScopeShareScopeKind },
): ScopeShareRecord | undefined {
    const row = tx
        .select()
        .from(scopeShares)
        .where(
            and(
                eq(scopeShares.scopeKind, scope.scopeKind),
                eq(scopeShares.scopeId, scope.scopeId),
                ne(scopeShares.state, "stopped"),
            ),
        )
        .get();
    return row === undefined ? undefined : shareRecord(row);
}

export function queryScopeShareMembers(tx: TX, shareId: string): readonly ScopeShareMemberRecord[] {
    return tx
        .select()
        .from(scopeShareMembers)
        .where(eq(scopeShareMembers.shareId, shareId))
        .orderBy(asc(scopeShareMembers.createdAtMs), asc(scopeShareMembers.shareMemberId))
        .all()
        .map((row) => ({
            createdAt: row.createdAtMs,
            currentGrantEpoch: row.currentGrantEpoch,
            displayName: row.displayName,
            murmurPeerId: row.murmurPeerId,
            shareId: row.shareId,
            shareMemberId: row.shareMemberId,
            state: row.state as ScopeShareMemberRecord["state"],
            updatedAt: row.updatedAtMs,
        }));
}

export function shareRecord(row: typeof scopeShares.$inferSelect): ScopeShareRecord {
    return {
        createdAt: row.createdAtMs,
        nextShareSequence: row.nextShareSequence,
        outboxBytes: row.outboxBytes,
        outboxCount: row.outboxCount,
        ownerPeerId: row.ownerPeerId,
        projectId: row.projectId,
        publishedScopeVersion: row.publishedScopeVersion,
        scopeId: row.scopeId,
        scopeKind: row.scopeKind as ScopeShareScopeKind,
        shareId: row.shareId,
        state: row.state as ScopeShareRecord["state"],
        ...(row.stoppedAtMs === null ? {} : { stoppedAt: row.stoppedAtMs }),
        updatedAt: row.updatedAtMs,
    };
}
