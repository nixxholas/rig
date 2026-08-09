import { inDatabase } from "../database/inDatabase.js";
import { eq } from "drizzle-orm";

import { projects } from "../database/schema.js";
import type { DatabaseScope } from "../Transaction.js";

export async function queryProjectUserMutationVersion(
    tx: DatabaseScope,
    projectId: string,
): Promise<number | undefined> {
    return await inDatabase(tx, async (tx) => {
        return (
            await tx
                .select({ userMutationVersion: projects.userMutationVersion })
                .from(projects)
                .where(eq(projects.id, projectId))
                .get()
        )?.userMutationVersion;
    });
}
