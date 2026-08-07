import { eq } from "drizzle-orm";

import { applets } from "../database/schema.js";
import type { TX } from "../Transaction.js";

/** Makes an existing version current without touching any other version. */
export function appletSetCurrentVersion(tx: TX, name: string, version: number, now: number): void {
    tx.update(applets)
        .set({ currentVersion: version, updatedAtMs: now })
        .where(eq(applets.name, name))
        .run();
}
