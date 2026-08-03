import { eq, sql } from "drizzle-orm";

import { scopeShareGrants, scopeShareMembers, scopeShares } from "../database/schema.js";
import { inTx } from "../inTx.js";
import type { TX } from "../Transaction.js";
import { scopeShareEntryLogPrune } from "./scopeShareEntryLogPrune.js";

export function scopeShareStop(tx: TX, shareId: string, now: number): boolean {
    return inTx(tx, (tx) => {
        const share = tx
            .select({ state: scopeShares.state })
            .from(scopeShares)
            .where(eq(scopeShares.shareId, shareId))
            .get();
        if (share === undefined || share.state === "stopped") return false;
        tx.update(scopeShareGrants)
            .set({ endedAtMs: now, state: "stopped" })
            .where(
                sql`${scopeShareGrants.shareMemberId} IN (
                    SELECT share_member_id FROM scope_share_members WHERE share_id = ${shareId}
                ) AND ${scopeShareGrants.state} = 'active'`,
            )
            .run();
        tx.update(scopeShareMembers)
            .set({ state: "stopped", updatedAtMs: now })
            .where(eq(scopeShareMembers.shareId, shareId))
            .run();
        tx.update(scopeShares)
            .set({ state: "stopped", stoppedAtMs: now, updatedAtMs: now })
            .where(eq(scopeShares.shareId, shareId))
            .run();
        // A stopped share admits no new member, so its entry log can never be offered
        // as history again. Prune it in the same transaction so a stopped share leaves
        // no permanent transcript duplicate behind.
        scopeShareEntryLogPrune(tx, shareId);
        return true;
    });
}
