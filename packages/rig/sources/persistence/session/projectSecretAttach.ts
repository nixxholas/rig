import type { Context } from "@steve.kite/stdlib";

import { inDatabase } from "../database/inDatabase.js";
import { projectSecretAttachments } from "../database/schema.js";

export async function projectSecretAttach(
    ctx: Context,
    projectId: string,
    secretId: string,
): Promise<void> {
    return await inDatabase(ctx, "rig.sql.session.project_secret_attach", async (ctx) => {
        const tx = ctx.tx;
        await tx
            .insert(projectSecretAttachments)
            .values({ projectId, secretId })
            .onConflictDoNothing()
            .run();
    });
}
