import type { Context } from "@steve.kite/stdlib";

import { inDatabase } from "../database/inDatabase.js";
import { eq } from "drizzle-orm";

import { sharingSettings } from "../database/schema.js";

export interface SharingSettings {
    enabled: boolean;
    updatedAt: number;
}

export async function querySharingSettings(ctx: Context): Promise<SharingSettings | undefined> {
    return await inDatabase(ctx, "rig.sql.sharing.querySharingSettings", async (ctx) => {
        const tx = ctx.tx;
        const stored = await tx
            .select({
                enabled: sharingSettings.enabled,
                updatedAt: sharingSettings.updatedAtMs,
            })
            .from(sharingSettings)
            .where(eq(sharingSettings.singletonId, 1))
            .get();
        return stored === undefined ? undefined : stored;
    });
}
