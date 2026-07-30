import { eq } from "drizzle-orm";

import { projectAvatarAssets } from "../database/schema.js";
import type { TX } from "../Transaction.js";

export function queryProjectAvatarAsset(
    tx: TX,
    hash: string,
): { height: number; mediaType: string; width: number } | undefined {
    return tx
        .select({
            height: projectAvatarAssets.height,
            mediaType: projectAvatarAssets.mediaType,
            width: projectAvatarAssets.width,
        })
        .from(projectAvatarAssets)
        .where(eq(projectAvatarAssets.hash, hash))
        .get();
}
