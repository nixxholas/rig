import type { Context } from "@steve.kite/stdlib";

import { inDatabase } from "../database/inDatabase.js";
import { and, asc, eq, isNotNull, lte, notExists } from "drizzle-orm";

import { projectAvatarAssets, projects } from "../database/schema.js";

export async function queryProjectAvatarGarbageCandidates(
    ctx: Context,
    cutoff: number,
    limit: number,
): Promise<readonly string[]> {
    return await inDatabase(
        ctx,
        "rig.sql.project.queryProjectAvatarGarbageCandidates",
        async (ctx) => {
            const tx = ctx.tx;
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
                    .orderBy(
                        asc(projectAvatarAssets.dereferencedAtMs),
                        asc(projectAvatarAssets.hash),
                    )
                    .limit(limit)
                    .all()
            ).map((row) => row.hash);
        },
    );
}
