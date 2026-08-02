import { and, eq } from "drizzle-orm";

import { slotEntries } from "../database/schema.js";
import type { TX } from "../Transaction.js";

/** Removes every entry owned by one uninstalled plugin without loading entry payloads. */
export function slotEntriesRemoveByPluginAuthor(tx: TX, folder: string): number {
    return Number(
        tx.delete(slotEntries)
            .where(and(eq(slotEntries.authorType, "plugin"), eq(slotEntries.authorId, folder)))
            .run().changes,
    );
}