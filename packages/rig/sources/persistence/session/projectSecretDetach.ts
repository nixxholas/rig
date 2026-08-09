import { inDatabase } from "../database/inDatabase.js";
import { and, eq } from "drizzle-orm";

import { projectSecretAttachments } from "../database/schema.js";
import type { DatabaseScope } from "../Transaction.js";

export async function projectSecretDetach(
    tx: DatabaseScope,
    projectId: string,
    secretId: string,
): Promise<void> {
    return await inDatabase(tx, async (tx) => {
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
