import { eq } from "drizzle-orm";

import { scopeShareEntries } from "../database/schema.js";
import type { TX } from "../Transaction.js";

/**
 * Delete a share's entry log. The log exists only so an owner can offer past
 * history to a member that joins later, so a stopped share — which can never
 * admit a new member — no longer needs it. Stopping only flips the share state,
 * so the `ON DELETE CASCADE` on the row never fires; without this prune a stopped
 * share would keep a full transcript duplicate in the database forever.
 */
export function scopeShareEntryLogPrune(tx: TX, shareId: string): void {
    tx.delete(scopeShareEntries).where(eq(scopeShareEntries.shareId, shareId)).run();
}
