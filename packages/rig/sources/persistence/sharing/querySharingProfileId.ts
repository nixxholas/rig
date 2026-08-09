import { inDatabase } from "../database/inDatabase.js";
import { eq } from "drizzle-orm";

import type { DatabaseScope } from "../Transaction.js";
import { sharingProfileBinding } from "../database/schema.js";

export interface SharingProfileBinding {
    murmurIdentity: string | null;
    profileId: string;
}

export async function querySharingProfileBinding(
    tx: DatabaseScope,
): Promise<SharingProfileBinding | undefined> {
    return await inDatabase(tx, async (tx) => {
        return await tx
            .select({
                murmurIdentity: sharingProfileBinding.murmurIdentity,
                profileId: sharingProfileBinding.profileId,
            })
            .from(sharingProfileBinding)
            .where(eq(sharingProfileBinding.singletonId, 1))
            .get();
    });
}

export async function querySharingProfileId(tx: DatabaseScope): Promise<string | undefined> {
    return (await querySharingProfileBinding(tx))?.profileId;
}
