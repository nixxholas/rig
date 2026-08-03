import { and, eq, ne } from "drizzle-orm";

import type { SessionShareTransportGrant } from "../../session-sharing/SessionShareTransport.js";
import { sessionShareGrants, sessionShareMembers } from "../database/schema.js";
import type { TX } from "../Transaction.js";

/** Immutable ended epochs that transport recovery may safely redeliver idempotently. */
export function querySessionShareEndedGrants(
    tx: TX,
    shareId: string,
): readonly SessionShareTransportGrant[] {
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
