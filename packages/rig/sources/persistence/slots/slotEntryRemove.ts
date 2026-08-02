import { eq } from "drizzle-orm";

import { slotEntries } from "../database/schema.js";
import type { TX } from "../Transaction.js";

export function slotEntryRemove(tx: TX, id: string): void {
    tx.delete(slotEntries).where(eq(slotEntries.id, id)).run();
}
