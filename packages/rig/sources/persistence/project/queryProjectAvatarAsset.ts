import { inDatabase } from "../database/inDatabase.js";
import { eq } from "drizzle-orm";

import { projectAvatarAssets } from "../database/schema.js";
import type { DatabaseScope } from "../Transaction.js";

export async function queryProjectAvatarAsset(
    tx: DatabaseScope,
    hash: string,
): Promise<{ height: number; mediaType: string; width: number } | undefined> {
    return await inDatabase(tx, async (tx) => {
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
