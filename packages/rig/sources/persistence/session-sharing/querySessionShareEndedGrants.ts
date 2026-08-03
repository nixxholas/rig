import { and, eq, ne } from "drizzle-orm";

import type { ShareTransportGrant } from "../../sharing/ShareTransport.js";
import { sessionShareGrants, sessionShareMembers } from "../database/schema.js";
import type { TX } from "../Transaction.js";

/** Immutable ended epochs that transport recovery may safely redeliver idempotently. */
export function querySessionShareEndedGrants(
    tx: TX,
    shareId: string,
): readonly ShareTransportGrant[] {
    return tx
        .select({
            grantEpoch: sessionShareGrants.grantEpoch,
            murmurPeerId: sessionShareMembers.murmurPeerId,
            shareId: sessionShareMembers.shareId,
            shareMemberId: sessionShareMembers.shareMemberId,
        })
        .from(sessionShareGrants)
        .innerJoin(
            sessionShareMembers,
            eq(sessionShareMembers.shareMemberId, sessionShareGrants.shareMemberId),
        )
        .where(
            and(eq(sessionShareMembers.shareId, shareId), ne(sessionShareGrants.state, "active")),
        )
        .all();
}
