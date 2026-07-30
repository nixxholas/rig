import { asc, gt } from "drizzle-orm";

import type { GlobalEvent, GlobalEventQueueEntry } from "../../protocol/index.js";
import { durableGlobalEvents } from "../database/schema.js";
import type { TX } from "../Transaction.js";

export function queryGlobalEvents(
    tx: TX,
    after: string | undefined,
    limit: number,
): readonly GlobalEventQueueEntry[] {
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
            ? query.all()
            : query.where(gt(durableGlobalEvents.cursor, after)).all();
    return rows.map((row) => ({
        cursor: row.cursor,
        event: JSON.parse(row.dataJson) as GlobalEvent,
    }));
}
