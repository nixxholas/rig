import { eq } from "drizzle-orm";

import type { SlotEntry } from "../../protocol/SlotProtocol.js";
import { slotEntries } from "../database/schema.js";
import type { TX } from "../Transaction.js";

/** Replaces the mutable columns of an existing entry with the given complete entry. */
export function slotEntryUpdate(tx: TX, entry: SlotEntry): void {
    tx.update(slotEntries)
        .set({
            contentJson: JSON.stringify(entry.content),
            description: entry.description,
            purpose: entry.purpose,
            slot: entry.slot,
            updatedAtMs: entry.updatedAt,
        })
        .where(eq(slotEntries.id, entry.id))
        .run();
}
