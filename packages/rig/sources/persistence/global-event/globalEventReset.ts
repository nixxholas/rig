import { durableGlobalEvents, durableGlobalEventState } from "../database/schema.js";

import { inTx } from "../inTx.js";
import type { DatabaseScope } from "../Transaction.js";

export async function globalEventReset(tx: DatabaseScope): Promise<number> {
    return await inTx(tx, async (tx) => {
        const changes = (await tx.delete(durableGlobalEvents).run()).rowsAffected;
        await tx.delete(durableGlobalEventState).run();
        return changes;
    });
}
