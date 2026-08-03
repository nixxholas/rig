import { and, eq, ne } from "drizzle-orm";

import type { ShareTransportGrant } from "../../sharing/ShareTransport.js";
import { scopeShareGrants, scopeShareMembers } from "../database/schema.js";
import type { TX } from "../Transaction.js";

/** Immutable ended epochs that transport recovery may safely redeliver idempotently. */
export function queryScopeShareEndedGrants(
    tx: TX,
    shareId: string,
): readonly ShareTransportGrant[] {
    return tx
        .select({
            grantEpoch: scopeShareGrants.grantEpoch,
            murmurPeerId: scopeShareMembers.murmurPeerId,
            shareId: scopeShareMembers.shareId,
            shareMemberId: scopeShareMembers.shareMemberId,
        })
        .from(scopeShareGrants)
        .innerJoin(
            scopeShareMembers,
            eq(scopeShareMembers.shareMemberId, scopeShareGrants.shareMemberId),
        )
        .where(and(eq(scopeShareMembers.shareId, shareId), ne(scopeShareGrants.state, "active")))
        .all();
}
