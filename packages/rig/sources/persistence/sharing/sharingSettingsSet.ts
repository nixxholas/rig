import type { Context } from "@steve.kite/stdlib";

import { inDatabase } from "../database/inDatabase.js";
import { sharingSettings } from "../database/schema.js";

export async function sharingSettingsSet(
    ctx: Context,
    enabled: boolean,
    updatedAt: number,
): Promise<void> {
    return await inDatabase(ctx, "rig.sql.sharing.sharingSettingsSet", async (ctx) => {
        const tx = ctx.tx;
        await tx
            .insert(sharingSettings)
            .values({ enabled, singletonId: 1, updatedAtMs: updatedAt })
            .onConflictDoUpdate({
                set: { enabled, updatedAtMs: updatedAt },
                target: sharingSettings.singletonId,
            })
            .run();
    });
}
