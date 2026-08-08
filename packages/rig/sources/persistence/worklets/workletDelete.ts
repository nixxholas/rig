import { eq } from "drizzle-orm";

import { worklets, workletVersions } from "../database/schema.js";
import { inTx } from "../inTx.js";
import type { TX } from "../Transaction.js";

/** Removes a worklet and its whole version history. Its `Data` folder is not touched here. */
export function workletDelete(tx: TX, name: string): void {
    inTx(tx, (transaction) => {
        transaction.delete(workletVersions).where(eq(workletVersions.workletName, name)).run();
        transaction.delete(worklets).where(eq(worklets.name, name)).run();
    });
}
