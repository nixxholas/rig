import { eq, lte } from "drizzle-orm";
import type { Context } from "@steve.kite/stdlib";

import { durableGlobalEvents, durableGlobalEventState } from "../database/schema.js";
import { inTx } from "../inTx.js";
import type { DatabaseScope } from "../Transaction.js";

export async function globalEventTrim(ctx: Context, through: string): Promise<number> {
    return await inTx(ctx, "rig.sql.global_events.trim", async (ctx) => {
        const tx = ctx.tx;
        const state = await tx.select().from(durableGlobalEventState).limit(1).get();
        if (state !== undefined && through <= state.trimmedThroughCursor) return 0;
        const changes = (
            await tx
                .delete(durableGlobalEvents)
                .where(lte(durableGlobalEvents.cursor, through))
                .run()
        ).rowsAffected;
        if (state === undefined) {
            await tx
                .insert(durableGlobalEventState)
                .values({ trimmedThroughCursor: through })
                .run();
        } else {
            await tx
                .update(durableGlobalEventState)
                .set({ trimmedThroughCursor: through })
                .where(eq(durableGlobalEventState.trimmedThroughCursor, state.trimmedThroughCursor))
                .run();
        }
        return changes;
    });
}
