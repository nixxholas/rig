import { and, eq, lte, sql } from "drizzle-orm";

import { sessionShareOutbox, sessionShares } from "../database/schema.js";
import { inTx } from "../inTx.js";
import type { TX } from "../Transaction.js";

export function sessionShareOutboxAcknowledge(
    tx: TX,
    input: { now: number; throughSequence: number; shareId: string },
): void {
    inTx(tx, (tx) => {
        const removed = tx
            .select({
                bytes: sql<number>`COALESCE(SUM(${sessionShareOutbox.byteLength}), 0)`,
                count: sql<number>`COUNT(*)`,
            })
            .from(sessionShareOutbox)
            .where(
                and(
                    eq(sessionShareOutbox.shareId, input.shareId),
                    lte(sessionShareOutbox.sequence, input.throughSequence),
                ),
            )
            .get();
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
                outboxBytes: sql`MAX(0, ${sessionShares.outboxBytes} - ${removed?.bytes ?? 0})`,
                outboxCount: sql`MAX(0, ${sessionShares.outboxCount} - ${removed?.count ?? 0})`,
                updatedAtMs: input.now,
            })
            .where(eq(sessionShares.shareId, input.shareId))
            .run();
    });
}
