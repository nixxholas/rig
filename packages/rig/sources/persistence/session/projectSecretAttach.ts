import { inDatabase } from "../database/inDatabase.js";
import { projectSecretAttachments } from "../database/schema.js";
import type { DatabaseScope } from "../Transaction.js";

export async function projectSecretAttach(
    tx: DatabaseScope,
    projectId: string,
    secretId: string,
): Promise<void> {
    return await inDatabase(tx, async (tx) => {
        await tx
            .insert(projectSecretAttachments)
            .values({ projectId, secretId })
            .onConflictDoNothing()
            .run();
    });
}
