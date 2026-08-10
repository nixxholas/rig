import type { Context } from "@steve.kite/stdlib";

import { eq } from "drizzle-orm";

import { folderShareOutbox, folderShares } from "../database/schema.js";
import { inDatabase } from "../database/inDatabase.js";
import { inTx } from "../inTx.js";

export async function folderShareOutboxSent(ctx: Context, operationId: string): Promise<void> {
    await inTx(ctx, "rig.sql.folderShare.folderShareOutboxSent", async (ctx) => {
        const tx = ctx.tx;
        await tx
            .delete(folderShareOutbox)
            .where(eq(folderShareOutbox.operationId, operationId))
            .run();
    });
}

export async function folderShareOutboxFailed(
    ctx: Context,
    operationId: string,
    error: string,
    now: number,
): Promise<void> {
    await inDatabase(ctx, "rig.sql.folderShare.folderShareOutboxFailed", async (ctx) => {
        const tx = ctx.tx;
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
