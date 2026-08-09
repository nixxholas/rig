import { eq } from "drizzle-orm";

import { folderShareOutbox, folderShares } from "../database/schema.js";
import { inTx } from "../inTx.js";
import type { TX } from "../Transaction.js";

export function folderShareOutboxSent(tx: TX, operationId: string): void {
    inTx(tx, (tx) => {
        tx.delete(folderShareOutbox).where(eq(folderShareOutbox.operationId, operationId)).run();
    });
}

export function folderShareOutboxFailed(
    tx: TX,
    operationId: string,
    error: string,
    now: number,
): void {
    const pending = tx
        .select({ groupId: folderShareOutbox.groupId })
        .from(folderShareOutbox)
        .where(eq(folderShareOutbox.operationId, operationId))
        .get();
    if (pending === undefined) return;
    tx.update(folderShares)
        .set({ error, status: "error", updatedAtMs: now })
        .where(eq(folderShares.groupId, pending.groupId))
        .run();
}
