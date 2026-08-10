import type { Context } from "@steve.kite/stdlib";

import { inDatabase } from "../database/inDatabase.js";
import { eq } from "drizzle-orm";

import { sharingProfileBinding } from "../database/schema.js";

export interface SharingProfileBinding {
    murmurIdentity: string | null;
    profileId: string;
}

export async function querySharingProfileBinding(
    ctx: Context,
): Promise<SharingProfileBinding | undefined> {
    return await inDatabase(ctx, "rig.sql.sharing.querySharingProfileBinding", async (ctx) => {
        const tx = ctx.tx;
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

export async function querySharingProfileId(ctx: Context): Promise<string | undefined> {
    return (await querySharingProfileBinding(ctx))?.profileId;
}
