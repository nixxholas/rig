import { and, asc, eq, isNotNull, lte, notExists } from "drizzle-orm";

import { projectAvatarAssets, projects } from "../database/schema.js";
import type { TX } from "../Transaction.js";

export function queryProjectAvatarGarbageCandidates(
    tx: TX,
    cutoff: number,
    limit: number,
): readonly string[] {
    return tx
        .select({ hash: projectAvatarAssets.hash })
        .from(projectAvatarAssets)
        .where(
            and(
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
        .orderBy(asc(projectAvatarAssets.dereferencedAtMs), asc(projectAvatarAssets.hash))
        .limit(limit)
        .all()
        .map((row) => row.hash);
}
