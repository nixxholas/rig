import { eq, lte } from "drizzle-orm";

import { durableGlobalEvents, durableGlobalEventState } from "../database/schema.js";
import { inTx } from "../inTx.js";
import type { TX } from "../Transaction.js";

export function globalEventTrim(tx: TX, through: string): number {
    return inTx(tx, (tx) => {
        const state = tx.select().from(durableGlobalEventState).limit(1).get();
        if (state !== undefined && through <= state.trimmedThroughCursor) return 0;
        const changes = tx
            .delete(durableGlobalEvents)
            .where(lte(durableGlobalEvents.cursor, through))
            .run().changes;
        if (state === undefined) {
            tx.insert(durableGlobalEventState).values({ trimmedThroughCursor: through }).run();
        } else {
            tx.update(durableGlobalEventState)
                .set({ trimmedThroughCursor: through })
                .where(eq(durableGlobalEventState.trimmedThroughCursor, state.trimmedThroughCursor))
                .run();
        }
        return changes;
    });
}
