import { eq } from "drizzle-orm";

import { projects } from "../database/schema.js";
import type { TX } from "../Transaction.js";

export function queryProjectUserMutationVersion(tx: TX, projectId: string): number | undefined {
    return tx
        .select({ userMutationVersion: projects.userMutationVersion })
        .from(projects)
        .where(eq(projects.id, projectId))
        .get()?.userMutationVersion;
}
