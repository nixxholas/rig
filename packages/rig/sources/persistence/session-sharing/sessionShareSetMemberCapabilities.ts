import { and, asc, eq } from "drizzle-orm";

import { sessionShareCapabilities, sessionShareMembers } from "../database/schema.js";
import { inTx } from "../inTx.js";
import type { TX } from "../Transaction.js";
import type { SessionShareCapabilityRecord, SessionSharePeerCapability } from "./types.js";

/**
 * Replace a member's capability set in one transaction. This is deliberately a
 * full replacement rather than a delta: a delta API on a security boundary
 * invites lost-update races between two owner clients, where one adds and the
 * other removes and the surviving state is whichever write landed last. The
 * owner always states the complete set it wants, so the result never depends on
 * ordering.
 */
export function sessionShareSetMemberCapabilities(
    tx: TX,
    input: {
        capabilities: readonly SessionSharePeerCapability[];
        now: number;
        shareId: string;
        shareMemberId: string;
    },
): readonly SessionShareCapabilityRecord[] {
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
        if (member === undefined || member.state !== "active") {
            throw new Error("This shared session has no active member to change permissions for.");
        }
        const epoch = member.currentGrantEpoch;
        const requested = new Set(input.capabilities);
        const existing = tx
            .select()
            .from(sessionShareCapabilities)
            .where(
                and(
                    eq(sessionShareCapabilities.shareMemberId, input.shareMemberId),
                    eq(sessionShareCapabilities.grantEpoch, epoch),
                ),
            )
            .all();
        // Revoke any capability that was active at this epoch but is no longer
        // requested. Rows at OTHER (older) epochs are left exactly as they are:
        // they are structurally unusable because the epoch no longer matches the
        // member's current grant epoch, and rewriting settled history serves
        // nobody.
        for (const row of existing) {
            if (
                row.state === "active" &&
                !requested.has(row.capability as SessionSharePeerCapability)
            ) {
                tx.update(sessionShareCapabilities)
                    .set({ revokedAtMs: input.now, state: "revoked" })
                    .where(
                        and(
                            eq(sessionShareCapabilities.shareMemberId, input.shareMemberId),
                            eq(sessionShareCapabilities.capability, row.capability),
                            eq(sessionShareCapabilities.grantEpoch, epoch),
                        ),
                    )
                    .run();
            }
        }
        // Grant every requested capability at the current epoch. Insert when the
        // row is absent; re-activate it when a row already exists at this epoch,
        // even one that was previously revoked.
        for (const capability of requested) {
            tx.insert(sessionShareCapabilities)
                .values({
                    capability,
                    grantEpoch: epoch,
                    grantedAtMs: input.now,
                    revokedAtMs: null,
                    shareMemberId: input.shareMemberId,
                    state: "active",
                })
                .onConflictDoUpdate({
                    set: { grantedAtMs: input.now, revokedAtMs: null, state: "active" },
                    target: [
                        sessionShareCapabilities.shareMemberId,
                        sessionShareCapabilities.capability,
                        sessionShareCapabilities.grantEpoch,
                    ],
                })
                .run();
        }
        return tx
            .select()
            .from(sessionShareCapabilities)
            .where(
                and(
                    eq(sessionShareCapabilities.shareMemberId, input.shareMemberId),
                    eq(sessionShareCapabilities.grantEpoch, epoch),
                    eq(sessionShareCapabilities.state, "active"),
                ),
            )
            .orderBy(asc(sessionShareCapabilities.capability))
            .all()
            .map((row) => ({
                capability: row.capability as SessionSharePeerCapability,
                grantEpoch: row.grantEpoch,
                grantedAt: row.grantedAtMs,
                shareMemberId: row.shareMemberId,
                state: row.state as SessionShareCapabilityRecord["state"],
                ...(row.revokedAtMs === null ? {} : { revokedAt: row.revokedAtMs }),
            }));
    });
}
