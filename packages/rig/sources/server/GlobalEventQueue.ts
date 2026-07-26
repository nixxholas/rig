import type {
    GlobalEvent,
    GlobalEventDelivery,
    GlobalEventQueueEntry,
    GlobalLiveEvent,
    TrimGlobalEventsResponse,
} from "../protocol/index.js";

export interface ListGlobalEventQueueOptions {
    after?: string;
    limit?: number;
}

export type GlobalEventQueueListener = (delivery: GlobalEventDelivery) => void;

export interface GlobalEventQueue {
    readonly durable: boolean;
    append(event: GlobalEvent): GlobalEventQueueEntry | undefined;
    cursor(): string;
    deactivate(): void;
    list(options?: ListGlobalEventQueueOptions): readonly GlobalEventQueueEntry[] | undefined;
    publish(entry: GlobalEventQueueEntry): void;
    /**
     * Delivers an event to current subscribers without storing it or advancing a cursor.
     *
     * This is a separate method rather than a flag inside `append` because the publish path treats
     * an `append` that returns nothing as "do not publish", so a classification hidden there would
     * silently swallow every live event in both implementations.
     */
    publishLive(event: GlobalLiveEvent): void;
    subscribe(listener: GlobalEventQueueListener, onClose?: () => void): () => void;
    trim(through: string): TrimGlobalEventsResponse | undefined;
}
