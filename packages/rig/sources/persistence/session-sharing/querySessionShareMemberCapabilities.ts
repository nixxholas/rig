import { and, asc, eq } from "drizzle-orm";

import { sessionShareCapabilities, sessionShareMembers } from "../database/schema.js";
import type { TX } from "../Transaction.js";
import type { SessionShareCapabilityRecord, SessionSharePeerCapability } from "./types.js";

/**
 * Active capability rows for every member of a share, each at that member's
 * current grant epoch only. Joining on `current_grant_epoch = grant_epoch`
 * discards rows left behind at an epoch the member has since moved past, so a
 * stale grant can never surface as a live capability.
 */
export function querySessionShareMemberCapabilities(
    tx: TX,
    shareId: string,
): readonly SessionShareCapabilityRecord[] {
    return tx
        .select({ row: sessionShareCapabilities })
        .from(sessionShareCapabilities)
        .innerJoin(
            sessionShareMembers,
            and(
                eq(sessionShareMembers.shareMemberId, sessionShareCapabilities.shareMemberId),
                eq(sessionShareMembers.currentGrantEpoch, sessionShareCapabilities.grantEpoch),
            ),
        )
        .where(
            and(
                eq(sessionShareMembers.shareId, shareId),
                eq(sessionShareCapabilities.state, "active"),
            ),
        )
        .orderBy(
            asc(sessionShareCapabilities.shareMemberId),
            asc(sessionShareCapabilities.capability),
        )
        .all()
        .map(({ row }) => toRecord(row));
}

/**
 * The single active capability row for one member at its current grant epoch, and
 * only when the member itself is active. This function is the durable half of the
 * security gate: a caller asks "may this peer do this now?" and the answer is the
 * presence of exactly one row. Absence of a row is denial. There is no third
 * state — a revoked member, a stale epoch, and a never-granted capability all
 * resolve to `undefined`, which the caller must treat as "no".
 */
export function querySessionShareMemberCapability(
    tx: TX,
    input: {
        capability: SessionSharePeerCapability;
        shareId: string;
        shareMemberId: string;
    },
): SessionShareCapabilityRecord | undefined {
    const row = tx
        .select({ row: sessionShareCapabilities })
        .from(sessionShareCapabilities)
        .innerJoin(
            sessionShareMembers,
            and(
                eq(sessionShareMembers.shareMemberId, sessionShareCapabilities.shareMemberId),
                eq(sessionShareMembers.currentGrantEpoch, sessionShareCapabilities.grantEpoch),
            ),
        )
        .where(
            and(
                eq(sessionShareMembers.shareId, input.shareId),
                eq(sessionShareMembers.shareMemberId, input.shareMemberId),
                eq(sessionShareMembers.state, "active"),
                eq(sessionShareCapabilities.capability, input.capability),
                eq(sessionShareCapabilities.state, "active"),
            ),
        )
        .get();
    return row === undefined ? undefined : toRecord(row.row);
}

function toRecord(row: typeof sessionShareCapabilities.$inferSelect): SessionShareCapabilityRecord {
    return {
        capability: row.capability as SessionSharePeerCapability,
        grantEpoch: row.grantEpoch,
        grantedAt: row.grantedAtMs,
        shareMemberId: row.shareMemberId,
        state: row.state as SessionShareCapabilityRecord["state"],
        ...(row.revokedAtMs === null ? {} : { revokedAt: row.revokedAtMs }),
    };
}
