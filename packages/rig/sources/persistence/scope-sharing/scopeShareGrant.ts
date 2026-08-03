import { and, eq } from "drizzle-orm";

import { scopeShareGrants, scopeShareMembers, scopeShares } from "../database/schema.js";
import { inTx } from "../inTx.js";
import type { TX } from "../Transaction.js";
import type { ScopeShareMemberRecord } from "./types.js";

export function scopeShareGrant(
    tx: TX,
    input: {
        displayName: string;
        murmurPeerId: string;
        now: number;
        shareId: string;
        shareMemberId: string;
    },
): ScopeShareMemberRecord {
    return inTx(tx, (tx) => {
        const share = tx
            .select({ state: scopeShares.state })
            .from(scopeShares)
            .where(eq(scopeShares.shareId, input.shareId))
            .get();
        if (share === undefined) throw new Error("The shared workspace or project does not exist.");
        if (share.state === "stopped") {
            throw new Error("A share that has stopped cannot grant access.");
        }
        const existing = tx
            .select()
            .from(scopeShareMembers)
            .where(
                and(
                    eq(scopeShareMembers.shareId, input.shareId),
                    eq(scopeShareMembers.murmurPeerId, input.murmurPeerId),
                ),
            )
            .get();
        if (existing?.state === "active") return memberRecord(existing);
        const grantEpoch = (existing?.currentGrantEpoch ?? 0) + 1;
        const shareMemberId = existing?.shareMemberId ?? input.shareMemberId;
        if (existing === undefined) {
            tx.insert(scopeShareMembers)
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
            tx.update(scopeShareMembers)
                .set({
                    currentGrantEpoch: grantEpoch,
                    displayName: input.displayName,
                    state: "active",
                    updatedAtMs: input.now,
                })
                .where(eq(scopeShareMembers.shareMemberId, shareMemberId))
                .run();
        }
        tx.insert(scopeShareGrants)
            .values({ createdAtMs: input.now, grantEpoch, shareMemberId, state: "active" })
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

function memberRecord(row: typeof scopeShareMembers.$inferSelect): ScopeShareMemberRecord {
    return {
        createdAt: row.createdAtMs,
        currentGrantEpoch: row.currentGrantEpoch,
        displayName: row.displayName,
        murmurPeerId: row.murmurPeerId,
        shareId: row.shareId,
        shareMemberId: row.shareMemberId,
        state: row.state as ScopeShareMemberRecord["state"],
        updatedAt: row.updatedAtMs,
    };
}
