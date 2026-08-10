import { inDatabase } from "../database/inDatabase.js";
import { eq } from "drizzle-orm";
import type { Context } from "@steve.kite/stdlib";

import { slotEntries } from "../database/schema.js";
import type { DatabaseScope } from "../Transaction.js";

export async function slotEntryRemove(ctx: Context, id: string): Promise<void> {
    return await inDatabase(ctx, "rig.sql.slots.remove_entry", async (ctx) => {
        const tx = ctx.tx;
        await tx.delete(slotEntries).where(eq(slotEntries.id, id)).run();
    });
}
