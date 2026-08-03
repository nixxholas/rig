import type {
    GlobalEvent,
    GlobalEventDelivery,
    GlobalEventQueueEntry,
    GlobalLiveEvent,
    TrimGlobalEventsResponse,
} from "../protocol/index.js";
import type { TX } from "../persistence/Transaction.js";

export interface ListGlobalEventQueueOptions {
    after?: string;
    limit?: number;
}

export type GlobalEventQueueListener = (delivery: GlobalEventDelivery) => void;

export interface GlobalEventQueue {
    readonly durable: boolean;
    append(event: GlobalEvent, tx?: TX): GlobalEventQueueEntry | undefined;
    /**
     * Appends an event delivered from a durable outbox whose source transaction
     * may have missed the acknowledgement of an earlier successful append.
     */
    appendReplaySafe(event: GlobalEvent, tx?: TX): GlobalEventQueueEntry | undefined;
    cursor(): string;
    deactivate(): void;
    list(options?: ListGlobalEventQueueOptions): readonly GlobalEventQueueEntry[] | undefined;
    publish(entry: GlobalEventQueueEntry): void;
    /**
     * Delivers an event to current subscribers without storing it or advancing a cursor, and
     * reports whether every subscriber accepted it.
     *
     * This is a separate method rather than a flag inside `append` because the publish path treats
     * an `append` that returns nothing as "do not publish", so a classification hidden there would
     * silently swallow every live event in both implementations.
     *
     * Subscribers are isolated from each other so one failure cannot starve the rest, but the
     * failure is still reported: a caller that cannot tell delivery apart from silence would record
     * a snapshot as published that nobody received. No subscribers counts as delivered.
     */
    publishLive(event: GlobalLiveEvent): boolean;
    subscribe(listener: GlobalEventQueueListener, onClose?: () => void): () => void;
    trim(through: string): TrimGlobalEventsResponse | undefined;
}
