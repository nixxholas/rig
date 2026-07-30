import { durableGlobalEvents, durableGlobalEventState } from "../database/schema.js";

import { inTx } from "../inTx.js";
import type { TX } from "../Transaction.js";

export function globalEventReset(tx: TX): number {
    return inTx(tx, (tx) => {
        const changes = tx.delete(durableGlobalEvents).run().changes;
        tx.delete(durableGlobalEventState).run();
        return changes;
    });
}
