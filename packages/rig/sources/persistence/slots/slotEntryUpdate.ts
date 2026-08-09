import { inDatabase } from "../database/inDatabase.js";
import { eq } from "drizzle-orm";

import type { SlotEntry } from "../../protocol/SlotProtocol.js";
import { slotEntries } from "../database/schema.js";
import type { DatabaseScope } from "../Transaction.js";

/** Replaces the mutable columns of an existing entry with the given complete entry. */
export async function slotEntryUpdate(tx: DatabaseScope, entry: SlotEntry): Promise<void> {
    return await inDatabase(tx, async (tx) => {
        await tx
            .update(slotEntries)
            .set({
                contentJson: JSON.stringify(entry.content),
                description: entry.description,
                purpose: entry.purpose,
                slot: entry.slot,
                updatedAtMs: entry.updatedAt,
            })
            .where(eq(slotEntries.id, entry.id))
            .run();
    });
}
