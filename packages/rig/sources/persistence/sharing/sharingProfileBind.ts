import type { Context } from "@steve.kite/stdlib";

import { eq } from "drizzle-orm";

import { inTx } from "../inTx.js";
import { sharingProfileBinding } from "../database/schema.js";
import { querySharingProfileBinding } from "./querySharingProfileId.js";

export async function sharingProfileBind(
    ctx: Context,
    profileId: string,
    murmurIdentity: string,
    createdAt: number,
): Promise<"created" | "unchanged"> {
    return await inTx(ctx, "rig.sql.sharing.sharingProfileBind", async (ctx) => {
        const tx = ctx.tx;
        const current = await querySharingProfileBinding(ctx);
        if (current !== undefined) {
            if (current.profileId !== profileId) {
                throw new Error("This Murmur identity is already bound to another Rig profile.");
            }
            if (current.murmurIdentity !== null && current.murmurIdentity !== murmurIdentity) {
                throw new Error("The stored Murmur identity does not match this Sharing profile.");
            }
            if (current.murmurIdentity === null) {
                await tx
                    .update(sharingProfileBinding)
                    .set({ murmurIdentity })
                    .where(eq(sharingProfileBinding.singletonId, 1))
                    .run();
            }
            return "unchanged";
        }
        await tx
            .insert(sharingProfileBinding)
            .values({ createdAtMs: createdAt, murmurIdentity, profileId, singletonId: 1 })
            .run();
        return "created";
    });
}
