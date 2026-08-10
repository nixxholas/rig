import { durableGlobalEvents, durableGlobalEventState } from "../database/schema.js";

import { inTx } from "../inTx.js";
import type { DatabaseScope } from "../Transaction.js";

export async function globalEventReset(ctx: Context): Promise<number> {
    return await inTx(ctx, "rig.sql.global_events.reset", async (ctx) => {
        const tx = ctx.tx;
        const changes = (await tx.delete(durableGlobalEvents).run()).rowsAffected;
        await tx.delete(durableGlobalEventState).run();
        return changes;
    });
}
import type { Context } from "@steve.kite/stdlib";
