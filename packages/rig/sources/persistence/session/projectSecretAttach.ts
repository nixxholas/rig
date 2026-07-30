import { projectSecretAttachments } from "../database/schema.js";
import type { TX } from "../Transaction.js";

export function projectSecretAttach(tx: TX, projectId: string, secretId: string): void {
    tx.insert(projectSecretAttachments).values({ projectId, secretId }).onConflictDoNothing().run();
}
