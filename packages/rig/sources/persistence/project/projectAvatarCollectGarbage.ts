import { and, eq, isNotNull, lte, notExists } from "drizzle-orm";

import { projectAvatarAssets, projects } from "../database/schema.js";
import type { TX } from "../Transaction.js";

export function projectAvatarCollectGarbage(tx: TX, hash: string, cutoff: number): boolean {
    const result = tx
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
    return result.changes > 0;
}
