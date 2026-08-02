import { eq } from "drizzle-orm";

import { webapps } from "../database/schema.js";
import type { TX } from "../Transaction.js";

/** Makes an existing version current without touching any other version. */
export function webappSetCurrentVersion(tx: TX, name: string, version: number, now: number): void {
    tx.update(webapps)
        .set({ currentVersion: version, updatedAtMs: now })
        .where(eq(webapps.name, name))
        .run();
}
