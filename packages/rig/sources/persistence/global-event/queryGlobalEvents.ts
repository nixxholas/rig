import { inDatabase } from "../database/inDatabase.js";
import { asc, gt } from "drizzle-orm";

import type { GlobalEvent, GlobalEventQueueEntry } from "../../protocol/index.js";
import { durableGlobalEvents } from "../database/schema.js";
import type { DatabaseScope } from "../Transaction.js";

export async function queryGlobalEvents(
    tx: DatabaseScope,
    after: string | undefined,
    limit: number,
): Promise<readonly GlobalEventQueueEntry[]> {
    return await inDatabase(tx, async (tx) => {
        const query = tx
            .select({
                cursor: durableGlobalEvents.cursor,
                dataJson: durableGlobalEvents.dataJson,
            })
            .from(durableGlobalEvents)
            .orderBy(asc(durableGlobalEvents.cursor))
            .limit(limit);
        const rows =
            after === undefined
                ? await query.all()
                : await query.where(gt(durableGlobalEvents.cursor, after)).all();
        return rows.map((row) => ({
            cursor: row.cursor,
            event: JSON.parse(row.dataJson) as GlobalEvent,
        }));
    });
}
