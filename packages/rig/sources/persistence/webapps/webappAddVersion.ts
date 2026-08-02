import { eq } from "drizzle-orm";

import { webapps, webappVersions } from "../database/schema.js";
import { inTx } from "../inTx.js";
import type { TX } from "../Transaction.js";

/** Records a newly imported version and makes it current in one consistent step. */
export function webappAddVersion(
    tx: TX,
    name: string,
    version: number,
    changeDescription: string,
    now: number,
): void {
    inTx(tx, (transaction) => {
        transaction
            .insert(webappVersions)
            .values({
                changeDescription,
                createdAtMs: now,
                version,
                webappName: name,
            })
            .run();
        transaction
            .update(webapps)
            .set({ currentVersion: version, updatedAtMs: now })
            .where(eq(webapps.name, name))
            .run();
    });
}
