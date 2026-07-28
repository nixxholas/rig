import { createEventIdFactory, type EventId, type GlobalEvent } from "../protocol/index.js";

/**
 * How many recent events the live stream can replay to a client that reconnects.
 *
 * A reconnect that lands inside this window resumes exactly where it left off.
 * One that falls outside it is told a gap was detected and reloads what it
 * holds, which is cheap because entities travel by request-response.
 */
export const LIVE_GLOBAL_EVENT_CAPACITY = 1_000;

export interface LiveGlobalEventEntry {
    /** This queue's own ordering position, not the event's identity. */
    cursor: EventId;
    event: GlobalEvent;
}

export type LiveGlobalEventListener = (entry: LiveGlobalEventEntry) => void;

/** What a resume cursor can no longer be served from memory. */
export const LIVE_GLOBAL_EVENT_GAP = "gap";

/**
 * The ephemeral stream every local client follows.
 *
 * One subscription carries everything: session events, project and workspace
 * changes, and the transient inference events a durable log deliberately drops.
 * Nothing here is stored beyond the replay window, so this queue is free to
 * carry what the durable log must not.
 *
 * Each entry is numbered with this queue's own strictly monotonic UUIDv7. An
 * event already carries an identity of its own, but identities minted by
 * different sessions interleave, and only one sequence can order the whole
 * stream. Cursors sort lexicographically, so comparing them is comparing text.
 */
export class LiveGlobalEventQueue {
    readonly #capacity: number;
    readonly #closeListeners = new Set<() => void>();
    readonly #entries: LiveGlobalEventEntry[] = [];
    readonly #listeners = new Set<LiveGlobalEventListener>();
    readonly #nextCursor: () => EventId;
    #head: EventId;

    constructor(options: { capacity?: number; now?: () => number } = {}) {
        this.#capacity = options.capacity ?? LIVE_GLOBAL_EVENT_CAPACITY;
        this.#nextCursor = createEventIdFactory(
            options.now === undefined ? {} : { now: options.now },
        );
        // The stream starts at a real position, so a client that connects before
        // anything has happened still has somewhere to resume from.
        this.#head = this.#nextCursor();
    }

    /** The newest position on the stream. A client attaches here. */
    cursor(): EventId {
        return this.#head;
    }

    publish(event: GlobalEvent): LiveGlobalEventEntry {
        const entry: LiveGlobalEventEntry = { cursor: this.#nextCursor(), event };
        this.#head = entry.cursor;
        this.#entries.push(entry);
        while (this.#entries.length > this.#capacity) this.#entries.shift();
        for (const listener of this.#listeners) {
            try {
                listener(entry);
            } catch {
                // One stuck subscriber must never stop the others from being told.
                // A subscriber that cannot keep up is disconnected by the stream
                // itself, which is where backpressure is actually observable.
            }
        }
        return entry;
    }

    /**
     * Events after `after`, or a gap when that position has aged out.
     *
     * Being caught up returns nothing, which is not a gap: a client at the head
     * has missed nothing.
     */
    since(after: EventId): readonly LiveGlobalEventEntry[] | typeof LIVE_GLOBAL_EVENT_GAP {
        if (after === this.#head) return [];
        const oldest = this.#entries[0];
        // Nothing retained: only a client already at the head is caught up, and
        // that case is settled above.
        if (oldest === undefined) return LIVE_GLOBAL_EVENT_GAP;
        // A cursor older than the window, or one this queue never issued, cannot
        // be resumed. Both look the same from here and both mean reload.
        if (after < oldest.cursor) return LIVE_GLOBAL_EVENT_GAP;
        if (after > this.#head) return LIVE_GLOBAL_EVENT_GAP;
        return this.#entries.filter((entry) => entry.cursor > after);
    }

    subscribe(listener: LiveGlobalEventListener, onClose?: () => void): () => void {
        this.#listeners.add(listener);
        if (onClose !== undefined) this.#closeListeners.add(onClose);
        return () => {
            this.#listeners.delete(listener);
            if (onClose !== undefined) this.#closeListeners.delete(onClose);
        };
    }

    /** Ends every subscription, so a replaced daemon store releases its readers. */
    close(): void {
        for (const listener of [...this.#closeListeners]) listener();
        this.#closeListeners.clear();
        this.#listeners.clear();
    }
}
