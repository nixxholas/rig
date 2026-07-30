import { eq } from "drizzle-orm";

import { sessions } from "../database/schema.js";
import type { TX } from "../Transaction.js";

export function sessionRepairInterruptedTitles(tx: TX, updatedAt: number): void {
    tx.update(sessions)
        .set({
            titleError: "Title generation was interrupted because the local server stopped.",
            titleStatus: "error",
            updatedAtMs: updatedAt,
        })
        .where(eq(sessions.titleStatus, "generating"))
        .run();
}
