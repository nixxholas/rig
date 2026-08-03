import { and, asc, eq, lte, sql } from "drizzle-orm";

import type { ScopeShareSubjectKind } from "../../scope-sharing/projectScopeShareEntry.js";
import { scopeShareOutbox, scopeShares } from "../database/schema.js";
import { inTx } from "../inTx.js";
import type { TX } from "../Transaction.js";
import { scopeShareEntryLogAppend } from "./scopeShareEntryLogAppend.js";

/**
 * Retire the outbox rows the transport has durably committed.
 *
 * Each acknowledged row is copied into the append-only entry log in the same
 * transaction as its deletion, so an owner can always page durable history back to
 * a member that joins later and no acknowledged entry can be lost between the two.
 */
export function scopeShareOutboxAcknowledge(
    tx: TX,
    input: { now: number; shareId: string; throughSequence: number },
): void {
    inTx(tx, (tx) => {
        const acknowledged = tx
            .select()
            .from(scopeShareOutbox)
            .where(
                and(
                    eq(scopeShareOutbox.shareId, input.shareId),
                    lte(scopeShareOutbox.sequence, input.throughSequence),
                ),
            )
            .orderBy(asc(scopeShareOutbox.sequence))
            .all();
        scopeShareEntryLogAppend(tx, {
            entries: acknowledged.map((row) => ({
                canonicalJson: row.canonicalJson,
                contentHash: row.contentHash,
                createdAt: row.createdAtMs,
                shareEventId: row.shareEventId,
                shareId: row.shareId,
                shareSequence: row.sequence,
                subjectId: row.subjectId,
                subjectKind: row.subjectKind as ScopeShareSubjectKind,
            })),
            shareId: input.shareId,
        });
        const removed = {
            bytes: acknowledged.reduce((total, row) => total + row.byteLength, 0),
            count: acknowledged.length,
        };
        tx.delete(scopeShareOutbox)
            .where(
                and(
                    eq(scopeShareOutbox.shareId, input.shareId),
                    lte(scopeShareOutbox.sequence, input.throughSequence),
                ),
            )
            .run();
        tx.update(scopeShares)
            .set({
                outboxBytes: sql`MAX(0, ${scopeShares.outboxBytes} - ${removed.bytes})`,
                outboxCount: sql`MAX(0, ${scopeShares.outboxCount} - ${removed.count})`,
                updatedAtMs: input.now,
            })
            .where(eq(scopeShares.shareId, input.shareId))
            .run();
    });
}
