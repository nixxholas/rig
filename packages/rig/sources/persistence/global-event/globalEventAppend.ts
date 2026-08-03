import type { GlobalEvent, GlobalEventQueueEntry } from "../../protocol/index.js";
import { durableGlobalEvents } from "../database/schema.js";

import type { TX } from "../Transaction.js";

export interface GlobalEventAppendOptions {
    aggregateId: string;
    aggregateKind: "compute" | "project" | "session" | "workspace";
    cursor: string;
    event: GlobalEvent;
}

export function globalEventAppend(
    tx: TX,
    options: GlobalEventAppendOptions,
): GlobalEventQueueEntry {
    tx.insert(durableGlobalEvents)
        .values({
            aggregateId: options.aggregateId,
            aggregateKind: options.aggregateKind,
            createdAtMs: options.event.createdAt,
            cursor: options.cursor,
            dataJson: JSON.stringify(options.event),
            eventId: options.event.id,
            type: options.event.type,
        })
        .run();
    return { cursor: options.cursor, event: options.event };
}
