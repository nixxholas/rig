import { eq, sql } from "drizzle-orm";

import {
    projectScopeShareEntry,
    scopeShareProjectionSubject,
    type ScopeShareProjection,
} from "../../scope-sharing/projectScopeShareEntry.js";
import { scopeShareOutbox, scopeShares } from "../database/schema.js";
import { inTx } from "../inTx.js";
import type { TX } from "../Transaction.js";
import type { ScopeShareOutboxRecord } from "./types.js";

export interface ScopeShareEnqueueLimits {
    readonly degradeAboveBytes: number;
    readonly degradeAboveCount: number;
}

/**
 * Take the next sequence for one share and hold a projection at it until the
 * transport has durably committed it.
 *
 * The sequence is claimed here rather than at publish time, which is what lets the
 * outbox be drained in pages and resumed after a restart. It is also why nothing
 * ever removes an outbox row ahead of acknowledgement: the gap would reach the
 * members as a hole they cannot skip. `undefined` means the share has run past its
 * degrade thresholds and is now marked degraded rather than growing further.
 */
export function scopeShareOutboxEnqueue(
    tx: TX,
    input: {
        createdAt: number;
        limits: ScopeShareEnqueueLimits;
        projection: ScopeShareProjection;
        shareEventId: string;
        shareId: string;
        sourceEventSeq?: number;
    },
): ScopeShareOutboxRecord | undefined {
    return inTx(tx, (tx) => {
        const share = tx
            .select()
            .from(scopeShares)
            .where(eq(scopeShares.shareId, input.shareId))
            .get();
        if (share === undefined) throw new Error("The scope share does not exist.");
        if (share.state === "stopped") throw new Error("A stopped scope share cannot publish.");
        const existing = tx
            .select()
            .from(scopeShareOutbox)
            .where(eq(scopeShareOutbox.shareEventId, input.shareEventId))
            .get();
        if (existing !== undefined) return outboxRecord(existing);
        const entry = projectScopeShareEntry({
            createdAt: input.createdAt,
            projection: input.projection,
            shareEventId: input.shareEventId,
            shareId: input.shareId,
            shareSequence: share.nextShareSequence,
        });
        const subject = scopeShareProjectionSubject(input.projection);
        const byteLength = Buffer.byteLength(entry.canonicalJson, "utf8");
        const nextBytes = share.outboxBytes + byteLength;
        const nextCount = share.outboxCount + 1;
        if (
            nextBytes > input.limits.degradeAboveBytes ||
            nextCount > input.limits.degradeAboveCount
        ) {
            tx.update(scopeShares)
                .set({ state: "degraded", updatedAtMs: input.createdAt })
                .where(eq(scopeShares.shareId, input.shareId))
                .run();
            return undefined;
        }
        tx.insert(scopeShareOutbox)
            .values({
                byteLength,
                canonicalJson: entry.canonicalJson,
                contentHash: entry.contentHash,
                createdAtMs: input.createdAt,
                sequence: share.nextShareSequence,
                shareEventId: input.shareEventId,
                shareId: input.shareId,
                sourceEventSeq: input.sourceEventSeq ?? null,
                subjectId: subject.subjectId,
                subjectKind: subject.subjectKind,
            })
            .run();
        tx.update(scopeShares)
            .set({
                nextShareSequence: sql`${scopeShares.nextShareSequence} + 1`,
                outboxBytes: nextBytes,
                outboxCount: nextCount,
                updatedAtMs: input.createdAt,
            })
            .where(eq(scopeShares.shareId, input.shareId))
            .run();
        return {
            byteLength,
            canonicalJson: entry.canonicalJson,
            contentHash: entry.contentHash,
            createdAt: input.createdAt,
            sequence: share.nextShareSequence,
            shareEventId: input.shareEventId,
            shareId: input.shareId,
            ...(input.sourceEventSeq === undefined ? {} : { sourceEventSeq: input.sourceEventSeq }),
            subjectId: subject.subjectId,
            subjectKind: subject.subjectKind,
        };
    });
}

function outboxRecord(row: typeof scopeShareOutbox.$inferSelect): ScopeShareOutboxRecord {
    return {
        byteLength: row.byteLength,
        canonicalJson: row.canonicalJson,
        contentHash: row.contentHash,
        createdAt: row.createdAtMs,
        sequence: row.sequence,
        shareEventId: row.shareEventId,
        shareId: row.shareId,
        ...(row.sourceEventSeq === null ? {} : { sourceEventSeq: row.sourceEventSeq }),
        subjectId: row.subjectId,
        subjectKind: row.subjectKind as ScopeShareOutboxRecord["subjectKind"],
    };
}
