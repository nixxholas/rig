import type { Context } from "@steve.kite/stdlib";

import { inDatabase } from "../database/inDatabase.js";
import { and, eq, isNotNull, lte, notExists } from "drizzle-orm";

import { projectAvatarAssets, projects } from "../database/schema.js";

export async function projectAvatarCollectGarbage(
    ctx: Context,
    hash: string,
    cutoff: number,
): Promise<boolean> {
    return await inDatabase(ctx, "rig.sql.project.projectAvatarCollectGarbage", async (ctx) => {
        const tx = ctx.tx;
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
