import { max } from "drizzle-orm";

import { durableGlobalEvents, durableGlobalEventState } from "../database/schema.js";
import type { TX } from "../Transaction.js";

export interface GlobalEventStartup {
    latestCursor: string | undefined;
    trimmedThrough: string | undefined;
}

export function queryGlobalEventStartup(tx: TX): GlobalEventStartup {
    const latestCursor = tx
        .select({ cursor: max(durableGlobalEvents.cursor) })
        .from(durableGlobalEvents)
        .get()?.cursor;
    const trimmedThrough = tx
        .select({ cursor: durableGlobalEventState.trimmedThroughCursor })
        .from(durableGlobalEventState)
        .limit(1)
        .get()?.cursor;
    return {
        latestCursor: latestCursor ?? undefined,
        trimmedThrough,
    };
}
