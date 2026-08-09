import { inDatabase } from "../database/inDatabase.js";
import { eq } from "drizzle-orm";

import { worklets } from "../database/schema.js";
import type { DatabaseScope } from "../Transaction.js";

/** Makes an existing version current without touching any other version. */
export async function workletSetCurrentVersion(
    tx: DatabaseScope,
    name: string,
    version: number,
    now: number,
): Promise<void> {
    return await inDatabase(tx, async (tx) => {
        await tx
            .update(worklets)
            .set({ currentVersion: version, updatedAtMs: now })
            .where(eq(worklets.name, name))
            .run();
    });
}
