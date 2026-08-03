import { and, asc, eq, lte, sql } from "drizzle-orm";

import { sessionShareOutbox, sessionShares } from "../database/schema.js";
import { inTx } from "../inTx.js";
import type { TX } from "../Transaction.js";
import { sessionShareEntryLogAppend } from "./sessionShareEntryLogAppend.js";

export function sessionShareOutboxAcknowledge(
    tx: TX,
    input: { now: number; throughSequence: number; shareId: string },
): void {
    inTx(tx, (tx) => {
        const acknowledged = tx
            .select()
            .from(sessionShareOutbox)
            .where(
                and(
                    eq(sessionShareOutbox.shareId, input.shareId),
                    lte(sessionShareOutbox.sequence, input.throughSequence),
                ),
            )
            .orderBy(asc(sessionShareOutbox.sequence))
            .all();
        sessionShareEntryLogAppend(tx, {
            entries: acknowledged.map((row) => ({
                canonicalJson: row.canonicalJson,
                contentHash: row.contentHash,
                createdAt: row.createdAtMs,
                shareEventId: row.shareEventId,
                shareId: row.shareId,
                shareSequence: row.sequence,
            })),
            shareId: input.shareId,
        });
        const removed = {
            bytes: acknowledged.reduce((total, row) => total + row.byteLength, 0),
            count: acknowledged.length,
        };
        tx.delete(sessionShareOutbox)
            .where(
                and(
                    eq(sessionShareOutbox.shareId, input.shareId),
                    lte(sessionShareOutbox.sequence, input.throughSequence),
                ),
            )
            .run();
        tx.update(sessionShares)
            .set({
                outboxBytes: sql`MAX(0, ${sessionShares.outboxBytes} - ${removed.bytes})`,
                outboxCount: sql`MAX(0, ${sessionShares.outboxCount} - ${removed.count})`,
                updatedAtMs: input.now,
            })
            .where(eq(sessionShares.shareId, input.shareId))
            .run();
    });
}
