import type {
    GlobalEvent,
    GlobalEventQueueEntry,
    TrimGlobalEventsResponse,
} from "../protocol/index.js";

export interface ListGlobalEventQueueOptions {
    after?: string;
    limit?: number;
}

export type GlobalEventQueueListener = (entry: GlobalEventQueueEntry) => void;

export interface GlobalEventQueue {
    readonly durable: boolean;
    append(event: GlobalEvent): GlobalEventQueueEntry | undefined;
    cursor(): string;
    deactivate(): void;
    list(options?: ListGlobalEventQueueOptions): readonly GlobalEventQueueEntry[] | undefined;
    publish(entry: GlobalEventQueueEntry): void;
    subscribe(listener: GlobalEventQueueListener, onClose?: () => void): () => void;
    trim(through: string): TrimGlobalEventsResponse | undefined;
}
