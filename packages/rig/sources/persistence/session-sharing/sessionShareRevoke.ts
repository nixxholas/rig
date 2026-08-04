import { and, eq } from "drizzle-orm";

import { sessionShareGrants, sessionShareMembers } from "../database/schema.js";
import { inTx } from "../inTx.js";
import { sessionShareRevokeMemberCapabilities } from "./sessionShareRevokeMemberCapabilities.js";
import type { TX } from "../Transaction.js";

export function sessionShareRevoke(
    tx: TX,
    input: { now: number; shareId: string; shareMemberId: string },
): boolean {
    return inTx(tx, (tx) => {
        const member = tx
            .select()
            .from(sessionShareMembers)
            .where(
                and(
                    eq(sessionShareMembers.shareId, input.shareId),
                    eq(sessionShareMembers.shareMemberId, input.shareMemberId),
                ),
            )
            .get();
        if (member === undefined || member.state !== "active") return false;
        tx.update(sessionShareGrants)
            .set({ endedAtMs: input.now, state: "revoked" })
            .where(
                and(
                    eq(sessionShareGrants.shareMemberId, input.shareMemberId),
                    eq(sessionShareGrants.grantEpoch, member.currentGrantEpoch),
                    eq(sessionShareGrants.state, "active"),
                ),
            )
            .run();
        tx.update(sessionShareMembers)
            .set({ state: "revoked", updatedAtMs: input.now })
            .where(eq(sessionShareMembers.shareMemberId, input.shareMemberId))
            .run();
        // A capability must never survive the grant it rested on. Revoking flips
        // the member's state rather than deleting the row, so the FK `ON DELETE
        // CASCADE` never fires; without this the capability rows would stay active
        // and the member would keep its access after being revoked.
        sessionShareRevokeMemberCapabilities(tx, {
            now: input.now,
            shareId: input.shareId,
            shareMemberId: input.shareMemberId,
        });
        return true;
    });
}
