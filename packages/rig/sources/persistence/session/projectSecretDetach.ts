import { and, eq } from "drizzle-orm";

import { projectSecretAttachments } from "../database/schema.js";
import type { TX } from "../Transaction.js";

export function projectSecretDetach(tx: TX, projectId: string, secretId: string): void {
    tx.delete(projectSecretAttachments)
        .where(
            and(
                eq(projectSecretAttachments.projectId, projectId),
                eq(projectSecretAttachments.secretId, secretId),
            ),
        )
        .run();
}
