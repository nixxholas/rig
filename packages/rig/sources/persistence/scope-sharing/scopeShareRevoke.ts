import { and, eq } from "drizzle-orm";

import { scopeShareGrants, scopeShareMembers } from "../database/schema.js";
import { inTx } from "../inTx.js";
import type { TX } from "../Transaction.js";

export function scopeShareRevoke(
    tx: TX,
    input: { now: number; shareId: string; shareMemberId: string },
): boolean {
    return inTx(tx, (tx) => {
        const member = tx
            .select()
            .from(scopeShareMembers)
            .where(
                and(
                    eq(scopeShareMembers.shareId, input.shareId),
                    eq(scopeShareMembers.shareMemberId, input.shareMemberId),
                ),
            )
            .get();
        if (member === undefined || member.state !== "active") return false;
        tx.update(scopeShareGrants)
            .set({ endedAtMs: input.now, state: "revoked" })
            .where(
                and(
                    eq(scopeShareGrants.shareMemberId, input.shareMemberId),
                    eq(scopeShareGrants.grantEpoch, member.currentGrantEpoch),
                    eq(scopeShareGrants.state, "active"),
                ),
            )
            .run();
        tx.update(scopeShareMembers)
            .set({ state: "revoked", updatedAtMs: input.now })
            .where(eq(scopeShareMembers.shareMemberId, input.shareMemberId))
            .run();
        return true;
    });
}
