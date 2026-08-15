import { eq } from "drizzle-orm";
import type { Context } from "@steve.kite/stdlib";

import { worklets, workletVersions } from "../database/schema.js";
import { inTx } from "../inTx.js";

/** Removes a worklet and its whole version history. Its `Data` folder is not touched here. */
export async function workletDelete(ctx: Context, name: string): Promise<void> {
    await inTx(ctx, "rig.sql.worklets.delete", async (ctx) => {
        const transaction = ctx.tx;
        await transaction
            .delete(workletVersions)
            .where(eq(workletVersions.workletName, name))
            .run();
        await transaction.delete(worklets).where(eq(worklets.name, name)).run();
    });
}
