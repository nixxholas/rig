import { eq } from "drizzle-orm";

import type { TX } from "../Transaction.js";
import { sharingProfileBinding } from "../database/schema.js";

export interface SharingProfileBinding {
    murmurIdentity: string | null;
    profileId: string;
}

export function querySharingProfileBinding(tx: TX): SharingProfileBinding | undefined {
    return tx
        .select({
            murmurIdentity: sharingProfileBinding.murmurIdentity,
            profileId: sharingProfileBinding.profileId,
        })
        .from(sharingProfileBinding)
        .where(eq(sharingProfileBinding.singletonId, 1))
        .get();
}

export function querySharingProfileId(tx: TX): string | undefined {
    return querySharingProfileBinding(tx)?.profileId;
}
