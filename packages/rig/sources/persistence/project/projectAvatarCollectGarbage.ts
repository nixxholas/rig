import { inDatabase } from "../database/inDatabase.js";
import { and, eq, isNotNull, lte, notExists } from "drizzle-orm";

import { projectAvatarAssets, projects } from "../database/schema.js";
import type { DatabaseScope } from "../Transaction.js";

export async function projectAvatarCollectGarbage(
    tx: DatabaseScope,
    hash: string,
    cutoff: number,
): Promise<boolean> {
    return await inDatabase(tx, async (tx) => {
        const result = await tx
            .delete(projectAvatarAssets)
            .where(
                and(
                    eq(projectAvatarAssets.hash, hash),
                    isNotNull(projectAvatarAssets.dereferencedAtMs),
                    lte(projectAvatarAssets.dereferencedAtMs, cutoff),
                    notExists(
                        tx
                            .select({ id: projects.id })
                            .from(projects)
                            .where(eq(projects.avatarHash, projectAvatarAssets.hash)),
                    ),
                ),
            )
            .run();
        return result.rowsAffected > 0;
    });
}
