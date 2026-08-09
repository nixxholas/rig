import { eq } from "drizzle-orm";

import { folderShareOutbox, folderShares } from "../database/schema.js";
import { inDatabase } from "../database/inDatabase.js";
import { inTx } from "../inTx.js";
import type { DatabaseScope } from "../Transaction.js";

export async function folderShareOutboxSent(tx: DatabaseScope, operationId: string): Promise<void> {
    await inTx(tx, async (tx) => {
        await tx
            .delete(folderShareOutbox)
            .where(eq(folderShareOutbox.operationId, operationId))
            .run();
    });
}

export async function folderShareOutboxFailed(
    tx: DatabaseScope,
    operationId: string,
    error: string,
    now: number,
): Promise<void> {
    await inDatabase(tx, async (tx) => {
        const pending = await tx
            .select({ groupId: folderShareOutbox.groupId })
            .from(folderShareOutbox)
            .where(eq(folderShareOutbox.operationId, operationId))
            .get();
        if (pending === undefined) return;
        await tx
            .update(folderShares)
            .set({ error, status: "error", updatedAtMs: now })
            .where(eq(folderShares.groupId, pending.groupId))
            .run();
    });
}
