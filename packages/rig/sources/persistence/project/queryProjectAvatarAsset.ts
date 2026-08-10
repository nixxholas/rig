import type { Context } from "@steve.kite/stdlib";

import { inDatabase } from "../database/inDatabase.js";
import { eq } from "drizzle-orm";

import { projectAvatarAssets } from "../database/schema.js";

export async function queryProjectAvatarAsset(
    ctx: Context,
    hash: string,
): Promise<{ height: number; mediaType: string; width: number } | undefined> {
    return await inDatabase(ctx, "rig.sql.project.queryProjectAvatarAsset", async (ctx) => {
        const tx = ctx.tx;
        return await tx
            .select({
                height: projectAvatarAssets.height,
                mediaType: projectAvatarAssets.mediaType,
                width: projectAvatarAssets.width,
            })
            .from(projectAvatarAssets)
            .where(eq(projectAvatarAssets.hash, hash))
            .get();
    });
}
