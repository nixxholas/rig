import { inDatabase } from "../database/inDatabase.js";
import { and, eq } from "drizzle-orm";

import { slotEntries } from "../database/schema.js";
import type { DatabaseScope } from "../Transaction.js";

/** Removes every entry owned by one uninstalled plugin without loading entry payloads. */
export async function slotEntriesRemoveByPluginAuthor(
    tx: DatabaseScope,
    folder: string,
): Promise<number> {
    return await inDatabase(tx, async (tx) => {
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
