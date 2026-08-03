import { and, eq } from "drizzle-orm";

import { sessionShareGrants, sessionShareMembers, sessionShares } from "../database/schema.js";
import { inTx } from "../inTx.js";
import type { TX } from "../Transaction.js";
import type { SessionShareMemberRecord } from "./types.js";

export function sessionShareGrant(
    tx: TX,
    input: {
        displayName: string;
        murmurPeerId: string;
        now: number;
        shareId: string;
        shareMemberId: string;
    },
): SessionShareMemberRecord {
    return inTx(tx, (tx) => {
        const share = tx
            .select({ state: sessionShares.state })
            .from(sessionShares)
            .where(eq(sessionShares.shareId, input.shareId))
            .get();
        if (share === undefined) throw new Error("The session share does not exist.");
        if (share.state === "stopped")
            throw new Error("A stopped session share cannot grant access.");

        const existing = tx
            .select()
            .from(sessionShareMembers)
            .where(
                and(
                    eq(sessionShareMembers.shareId, input.shareId),
                    eq(sessionShareMembers.murmurPeerId, input.murmurPeerId),
                ),
            )
            .get();
        if (existing?.state === "active") return memberRecord(existing);
        const grantEpoch = (existing?.currentGrantEpoch ?? 0) + 1;
        const shareMemberId = existing?.shareMemberId ?? input.shareMemberId;
        if (existing === undefined) {
            tx.insert(sessionShareMembers)
                .values({
                    createdAtMs: input.now,
                    currentGrantEpoch: grantEpoch,
                    displayName: input.displayName,
                    murmurPeerId: input.murmurPeerId,
                    shareId: input.shareId,
                    shareMemberId,
                    state: "active",
                    updatedAtMs: input.now,
                })
                .run();
        } else {
            tx.update(sessionShareMembers)
                .set({
                    currentGrantEpoch: grantEpoch,
                    displayName: input.displayName,
                    state: "active",
                    updatedAtMs: input.now,
                })
                .where(eq(sessionShareMembers.shareMemberId, shareMemberId))
                .run();
        }
        tx.insert(sessionShareGrants)
            .values({
                createdAtMs: input.now,
                grantEpoch,
                shareMemberId,
                state: "active",
            })
            .run();
        return {
            createdAt: existing?.createdAtMs ?? input.now,
            currentGrantEpoch: grantEpoch,
            displayName: input.displayName,
            murmurPeerId: input.murmurPeerId,
            shareId: input.shareId,
            shareMemberId,
            state: "active",
            updatedAt: input.now,
        };
    });
}

function memberRecord(row: typeof sessionShareMembers.$inferSelect): SessionShareMemberRecord {
    return {
        createdAt: row.createdAtMs,
        currentGrantEpoch: row.currentGrantEpoch,
        displayName: row.displayName,
        murmurPeerId: row.murmurPeerId,
        shareId: row.shareId,
        shareMemberId: row.shareMemberId,
        state: row.state as SessionShareMemberRecord["state"],
        updatedAt: row.updatedAtMs,
    };
}
