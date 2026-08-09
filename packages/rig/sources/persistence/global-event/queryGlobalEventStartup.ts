import { inDatabase } from "../database/inDatabase.js";
import { max } from "drizzle-orm";

import { durableGlobalEvents, durableGlobalEventState } from "../database/schema.js";
import type { DatabaseScope } from "../Transaction.js";

export interface GlobalEventStartup {
    latestCursor: string | undefined;
    trimmedThrough: string | undefined;
}

export async function queryGlobalEventStartup(tx: DatabaseScope): Promise<GlobalEventStartup> {
    return await inDatabase(tx, async (tx) => {
        const latestCursor = (
            await tx
                .select({ cursor: max(durableGlobalEvents.cursor) })
                .from(durableGlobalEvents)
                .get()
        )?.cursor;
        const trimmedThrough = (
            await tx
                .select({ cursor: durableGlobalEventState.trimmedThroughCursor })
                .from(durableGlobalEventState)
                .limit(1)
                .get()
        )?.cursor;
        return {
            latestCursor: latestCursor ?? undefined,
            trimmedThrough,
        };
    });
}
