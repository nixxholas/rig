import { eq, sql } from "drizzle-orm";

import { sessionShareGrants, sessionShareMembers, sessionShares } from "../database/schema.js";
import { inTx } from "../inTx.js";
import type { TX } from "../Transaction.js";
import { sessionShareEntryLogPrune } from "./sessionShareEntryLogPrune.js";

export function sessionShareStop(
    tx: TX,
    shareId: string,
    now: number,
    options: { readonly pruneEntryLog: boolean } = { pruneEntryLog: true },
): boolean {
    return inTx(tx, (tx) => {
        const share = tx
            .select({ state: sessionShares.state })
            .from(sessionShares)
            .where(eq(sessionShares.shareId, shareId))
            .get();
        if (share === undefined || share.state === "stopped") return false;
        tx.update(sessionShareGrants)
            .set({ endedAtMs: now, state: "stopped" })
            .where(
                sql`${sessionShareGrants.shareMemberId} IN (
                    SELECT share_member_id FROM session_share_members WHERE share_id = ${shareId}
                ) AND ${sessionShareGrants.state} = 'active'`,
            )
            .run();
        tx.update(sessionShareMembers)
            .set({ state: "stopped", updatedAtMs: now })
            .where(eq(sessionShareMembers.shareId, shareId))
            .run();
        tx.update(sessionShares)
            .set({ state: "stopped", stoppedAtMs: now, updatedAtMs: now })
            .where(eq(sessionShares.shareId, shareId))
            .run();
        // A stopped share admits no new member, so its entry log can never be
        // offered as history again. Prune it in the same transaction so a stopped
        // share leaves no permanent transcript duplicate behind. A share stopped by
        // the transport rather than by the owner keeps its log: deleting the owner's
        // history because a peer sent a bad frame is destructive and unasked for.
        if (options.pruneEntryLog) sessionShareEntryLogPrune(tx, shareId);
        return true;
    });
}
