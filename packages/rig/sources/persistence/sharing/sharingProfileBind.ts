import { eq } from "drizzle-orm";

import type { TX } from "../Transaction.js";
import { sharingProfileBinding } from "../database/schema.js";
import { querySharingProfileBinding } from "./querySharingProfileId.js";

export function sharingProfileBind(
    tx: TX,
    profileId: string,
    murmurIdentity: string,
    createdAt: number,
): "created" | "unchanged" {
    const current = querySharingProfileBinding(tx);
    if (current !== undefined) {
        if (current.profileId !== profileId) {
            throw new Error("This Murmur identity is already bound to another Rig profile.");
        }
        if (current.murmurIdentity !== null && current.murmurIdentity !== murmurIdentity) {
            throw new Error("The stored Murmur identity does not match this Sharing profile.");
        }
        if (current.murmurIdentity === null) {
            tx.update(sharingProfileBinding)
                .set({ murmurIdentity })
                .where(eq(sharingProfileBinding.singletonId, 1))
                .run();
        }
        return "unchanged";
    }
    tx.insert(sharingProfileBinding)
        .values({ createdAtMs: createdAt, murmurIdentity, profileId, singletonId: 1 })
        .run();
    return "created";
}
