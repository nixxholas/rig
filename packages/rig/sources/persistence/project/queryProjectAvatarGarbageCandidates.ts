import { inDatabase } from "../database/inDatabase.js";
import { and, asc, eq, isNotNull, lte, notExists } from "drizzle-orm";

import { projectAvatarAssets, projects } from "../database/schema.js";
import type { DatabaseScope } from "../Transaction.js";

export async function queryProjectAvatarGarbageCandidates(
    tx: DatabaseScope,
    cutoff: number,
    limit: number,
): Promise<readonly string[]> {
    return await inDatabase(tx, async (tx) => {
        return (
            await tx
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
        ).map((row) => row.hash);
    });
}
