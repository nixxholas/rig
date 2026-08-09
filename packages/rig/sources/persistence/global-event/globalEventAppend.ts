import { eq } from "drizzle-orm";

import type { GlobalEvent, GlobalEventQueueEntry } from "../../protocol/index.js";
import { durableGlobalEvents } from "../database/schema.js";

import type { TX } from "../Transaction.js";

export interface GlobalEventAppendOptions {
    aggregateId: string;
    aggregateKind: "compute" | "document" | "folder" | "project" | "session" | "workspace";
    cursor: string;
    event: GlobalEvent;
}

export function globalEventAppend(
    tx: TX,
    options: GlobalEventAppendOptions,
): GlobalEventQueueEntry {
    const dataJson = JSON.stringify(options.event);
    tx.insert(durableGlobalEvents)
        .values({
            aggregateId: options.aggregateId,
            aggregateKind: options.aggregateKind,
            createdAtMs: options.event.createdAt,
            cursor: options.cursor,
            dataJson,
            eventId: options.event.id,
            type: options.event.type,
        })
        .run();
    return { cursor: options.cursor, event: options.event };
}

/**
 * Appends a cross-database outbox event once.
 *
 * A repeated, byte-identical event means the source outbox crashed after this
 * database committed and may now safely advance. Reusing an event ID for
 * different content is still an invariant violation.
 */
export function globalEventAppendReplaySafe(
    tx: TX,
    options: GlobalEventAppendOptions,
): GlobalEventQueueEntry | undefined {
    const dataJson = JSON.stringify(options.event);
    const inserted = tx
        .insert(durableGlobalEvents)
        .values({
            aggregateId: options.aggregateId,
            aggregateKind: options.aggregateKind,
            createdAtMs: options.event.createdAt,
            cursor: options.cursor,
            dataJson,
            eventId: options.event.id,
            type: options.event.type,
        })
        .onConflictDoNothing({ target: durableGlobalEvents.eventId })
        .run();
    if (inserted.changes > 0) return { cursor: options.cursor, event: options.event };

    const existing = tx
        .select({
            aggregateId: durableGlobalEvents.aggregateId,
            aggregateKind: durableGlobalEvents.aggregateKind,
            createdAtMs: durableGlobalEvents.createdAtMs,
            dataJson: durableGlobalEvents.dataJson,
            type: durableGlobalEvents.type,
        })
        .from(durableGlobalEvents)
        .where(eq(durableGlobalEvents.eventId, options.event.id))
        .get();
    if (
        existing === undefined ||
        existing.aggregateId !== options.aggregateId ||
        existing.aggregateKind !== options.aggregateKind ||
        existing.createdAtMs !== options.event.createdAt ||
        existing.dataJson !== dataJson ||
        existing.type !== options.event.type
    ) {
        throw new Error(`Global event ${options.event.id} was reused with different content`);
    }
    return undefined;
}
