import { eq } from "drizzle-orm";

import { worklets, workletVersions } from "../database/schema.js";
import { inTx } from "../inTx.js";
import type { DatabaseScope } from "../Transaction.js";

/** Removes a worklet and its whole version history. Its `Data` folder is not touched here. */
export async function workletDelete(tx: DatabaseScope, name: string): Promise<void> {
    await inTx(tx, async (transaction) => {
        await transaction
            .delete(workletVersions)
            .where(eq(workletVersions.workletName, name))
            .run();
        await transaction.delete(worklets).where(eq(worklets.name, name)).run();
    });
}
