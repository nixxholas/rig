import { inDatabase } from "../database/inDatabase.js";
import { eq } from "drizzle-orm";

import { sessions } from "../database/schema.js";
import type { DatabaseScope } from "../Transaction.js";

export async function sessionRepairInterruptedTitles(
    tx: DatabaseScope,
    updatedAt: number,
): Promise<void> {
    return await inDatabase(tx, async (tx) => {
        await tx
            .update(sessions)
            .set({
                titleError: "Title generation was interrupted because the local server stopped.",
                titleStatus: "error",
                updatedAtMs: updatedAt,
            })
            .where(eq(sessions.titleStatus, "generating"))
            .run();
    });
}
