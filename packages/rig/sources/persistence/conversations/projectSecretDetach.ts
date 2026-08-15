import type { Context } from "@steve.kite/stdlib";

import { inDatabase } from "../database/inDatabase.js";
import { and, eq } from "drizzle-orm";

import { projectSecretAttachments } from "../database/schema.js";

export async function projectSecretDetach(
    ctx: Context,
    projectId: string,
    secretId: string,
): Promise<void> {
    return await inDatabase(ctx, "rig.sql.session.project_secret_detach", async (ctx) => {
        const tx = ctx.tx;
        await tx
            .delete(projectSecretAttachments)
            .where(
                and(
                    eq(projectSecretAttachments.projectId, projectId),
                    eq(projectSecretAttachments.secretId, secretId),
                ),
            )
            .run();
    });
}
