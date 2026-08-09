import { inDatabase } from "../database/inDatabase.js";
import { eq } from "drizzle-orm";

import { slotEntries } from "../database/schema.js";
import type { DatabaseScope } from "../Transaction.js";

export async function slotEntryRemove(tx: DatabaseScope, id: string): Promise<void> {
    return await inDatabase(tx, async (tx) => {
        await tx.delete(slotEntries).where(eq(slotEntries.id, id)).run();
    });
}
