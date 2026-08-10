import { inDatabase } from "../database/inDatabase.js";
import { and, eq } from "drizzle-orm";
import type { Context } from "@steve.kite/stdlib";

import { slotEntries } from "../database/schema.js";
import type { DatabaseScope } from "../Transaction.js";

/** Removes every entry owned by one uninstalled plugin without loading entry payloads. */
export async function slotEntriesRemoveByPluginAuthor(
    ctx: Context,
    folder: string,
): Promise<number> {
    return await inDatabase(ctx, "rig.sql.slots.remove_by_plugin", async (ctx) => {
        const tx = ctx.tx;
        return Number(
            (
                await tx
                    .delete(slotEntries)
                    .where(
                        and(eq(slotEntries.authorType, "plugin"), eq(slotEntries.authorId, folder)),
                    )
                    .run()
            ).rowsAffected,
        );
    });
}
