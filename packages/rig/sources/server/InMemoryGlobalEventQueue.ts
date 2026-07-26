import { createId } from "@paralleldrive/cuid2";

import type {
    GlobalEvent,
    GlobalEventQueueEntry,
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
    readonly #entries: GlobalEventQueueEntry[] = [];
    readonly #listeners = new Set<GlobalEventQueueListener>();
    readonly #streamId = createId();
    #lastPosition = 0;
    #trimmedThrough = 0;

    constructor(options: { capacity?: number } = {}) {
        this.#capacity = options.capacity ?? 10_000;
    }

    append(event: GlobalEvent): GlobalEventQueueEntry {
        this.#lastPosition += 1;
        const entry = { cursor: this.#cursor(this.#lastPosition), event };
        this.#entries.push(entry);
        while (this.#entries.length > this.#capacity) {
            const removed = this.#entries.shift();
            if (removed !== undefined) {
                this.#trimmedThrough = this.#position(removed.cursor) ?? this.#trimmedThrough;
            }
        }
        return entry;
    }

    cursor(): string {
        return this.#cursor(this.#lastPosition);
    }

    deactivate(): void {
        for (const listener of this.#closeListeners) listener();
        this.#closeListeners.clear();
        this.#listeners.clear();
    }

    list(options: ListGlobalEventQueueOptions = {}): readonly GlobalEventQueueEntry[] | undefined {
        const after =
            options.after === undefined ? this.#trimmedThrough : this.#position(options.after);
        if (after === undefined || after < this.#trimmedThrough || after > this.#lastPosition) {
            return undefined;
        }
        const entries = this.#entries.filter(
            (entry) => (this.#position(entry.cursor) ?? 0) > after,
        );
        return options.limit === undefined ? entries : entries.slice(0, options.limit);
    }

    publish(entry: GlobalEventQueueEntry): void {
        for (const listener of this.#listeners) listener(entry);
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
        const position = this.#position(through);
        if (position === undefined || position > this.#lastPosition) return undefined;
        if (position <= this.#trimmedThrough) return { through, trimmed: 0 };
        const before = this.#entries.length;
        while (
            this.#entries.length > 0 &&
            (this.#position(this.#entries[0]!.cursor) ?? 0) <= position
        ) {
            this.#entries.shift();
        }
        this.#trimmedThrough = position;
        return { through, trimmed: before - this.#entries.length };
    }

    #cursor(position: number): string {
        return `${this.#streamId}.${position.toString(36)}`;
    }

    #position(cursor: string): number | undefined {
        const [streamId, encoded, extra] = cursor.split(".");
        if (streamId !== this.#streamId || encoded === undefined || extra !== undefined) {
            return undefined;
        }
        const position = Number.parseInt(encoded, 36);
        return Number.isSafeInteger(position) && position >= 0 ? position : undefined;
    }
}
