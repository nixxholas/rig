import { createEventIdFactory, eventIdsShareScope } from "../protocol/index.js";
import type {
    EventId,
    GlobalEvent,
    GlobalEventQueueEntry,
    GlobalLiveEvent,
    TrimGlobalEventsResponse,
} from "../protocol/index.js";
import type {
    GlobalEventQueue,
    GlobalEventQueueListener,
    ListGlobalEventQueueOptions,
} from "./GlobalEventQueue.js";

export class InMemoryGlobalEventQueue implements GlobalEventQueue {
    readonly durable = false;
    readonly #capacity: number;
    readonly #closeListeners = new Set<() => void>();
    readonly #createCursor: () => EventId;
    readonly #entries: GlobalEventQueueEntry[] = [];
    readonly #listeners = new Set<GlobalEventQueueListener>();
    #head: EventId;
    #trimmedThrough: EventId;

    constructor(options: { capacity?: number; now?: () => number } = {}) {
        this.#capacity = options.capacity ?? 10_000;
        this.#createCursor = createEventIdFactory(
            options.now === undefined ? {} : { now: options.now },
        );
        this.#head = this.#createCursor();
        this.#trimmedThrough = this.#head;
    }

    append(event: GlobalEvent): GlobalEventQueueEntry {
        const entry = { cursor: this.#createCursor(), event };
        this.#head = entry.cursor;
        this.#entries.push(entry);
        while (this.#entries.length > this.#capacity) {
            const removed = this.#entries.shift();
            if (removed !== undefined) this.#trimmedThrough = removed.cursor;
        }
        return entry;
    }

    appendReplaySafe(event: GlobalEvent): GlobalEventQueueEntry | undefined {
        const existing = this.#entries.find((entry) => entry.event.id === event.id);
        if (existing === undefined) return this.append(event);
        if (JSON.stringify(existing.event) !== JSON.stringify(event)) {
            throw new Error(`Global event ${event.id} was reused with different content`);
        }
        return undefined;
    }

    cursor(): string {
        return this.#head;
    }

    deactivate(): void {
        for (const listener of this.#closeListeners) listener();
        this.#closeListeners.clear();
        this.#listeners.clear();
    }

    list(options: ListGlobalEventQueueOptions = {}): readonly GlobalEventQueueEntry[] | undefined {
        const after = options.after?.toLowerCase() ?? this.#trimmedThrough;
        if (
            !eventIdsShareScope(after, this.#head) ||
            after < this.#trimmedThrough ||
            after > this.#head
        ) {
            return undefined;
        }
        const entries = this.#entries.filter((entry) => entry.cursor > after);
        return options.limit === undefined ? entries : entries.slice(0, options.limit);
    }

    publish(entry: GlobalEventQueueEntry): void {
        for (const listener of this.#listeners) {
            try {
                listener(entry);
            } catch {
                // One failed subscriber must not prevent every later
                // subscriber from receiving an already-recorded event.
            }
        }
    }

    publishLive(event: GlobalLiveEvent): boolean {
        let delivered = true;
        for (const listener of this.#listeners) {
            try {
                listener({ event, live: true });
            } catch {
                // One failing subscriber must not stop the others from being told, but the caller
                // still has to learn that this event did not reach everyone.
                delivered = false;
            }
        }
        return delivered;
    }

    subscribe(listener: GlobalEventQueueListener, onClose?: () => void): () => void {
        this.#listeners.add(listener);
        if (onClose !== undefined) this.#closeListeners.add(onClose);
        return () => {
            this.#listeners.delete(listener);
            if (onClose !== undefined) this.#closeListeners.delete(onClose);
        };
    }

    trim(through: string): TrimGlobalEventsResponse | undefined {
        const normalized = through.toLowerCase();
        if (!eventIdsShareScope(normalized, this.#head) || normalized > this.#head)
            return undefined;
        if (normalized <= this.#trimmedThrough) return { through: normalized, trimmed: 0 };
        const before = this.#entries.length;
        while (this.#entries.length > 0 && this.#entries[0]!.cursor <= normalized) {
            this.#entries.shift();
        }
        this.#trimmedThrough = normalized;
        return { through: normalized, trimmed: before - this.#entries.length };
    }
}
