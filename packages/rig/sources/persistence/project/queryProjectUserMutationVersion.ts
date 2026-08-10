import type { Context } from "@steve.kite/stdlib";

import { inDatabase } from "../database/inDatabase.js";
import { eq } from "drizzle-orm";

import { projects } from "../database/schema.js";

export async function queryProjectUserMutationVersion(
    ctx: Context,
    projectId: string,
): Promise<number | undefined> {
    return await inDatabase(ctx, "rig.sql.project.queryProjectUserMutationVersion", async (ctx) => {
        const tx = ctx.tx;
        return (
            await tx
                .select({ userMutationVersion: projects.userMutationVersion })
                .from(projects)
                .where(eq(projects.id, projectId))
                .get()
        )?.userMutationVersion;
    });
}
