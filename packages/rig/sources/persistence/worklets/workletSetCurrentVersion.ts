import { eq } from "drizzle-orm";

import { worklets } from "../database/schema.js";
import type { TX } from "../Transaction.js";

/** Makes an existing version current without touching any other version. */
export function workletSetCurrentVersion(tx: TX, name: string, version: number, now: number): void {
    tx.update(worklets)
        .set({ currentVersion: version, updatedAtMs: now })
        .where(eq(worklets.name, name))
        .run();
}
