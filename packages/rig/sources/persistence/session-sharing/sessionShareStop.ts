import { eq, sql } from "drizzle-orm";

import { sessionShareGrants, sessionShareMembers, sessionShares } from "../database/schema.js";
import { inTx } from "../inTx.js";
import type { TX } from "../Transaction.js";

export function sessionShareStop(tx: TX, shareId: string, now: number): boolean {
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
        return true;
    });
}
