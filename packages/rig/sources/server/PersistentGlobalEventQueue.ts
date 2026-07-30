import { asc, gt, max } from "drizzle-orm";
import { createEventIdFactory, eventIdsShareScope, isLiveGlobalEvent } from "../protocol/index.js";
import { globalEventAppend } from "../persistence/global-event/globalEventAppend.js";
import { globalEventReset } from "../persistence/global-event/globalEventReset.js";
import { globalEventTrim } from "../persistence/global-event/globalEventTrim.js";
import type { TX } from "../persistence/Transaction.js";

import type {
    EventId,
    GlobalEvent,
    GlobalLiveEvent,
    GlobalEventQueueEntry,
    ProjectEvent,
    TrimGlobalEventsResponse,
} from "../protocol/index.js";
import type {
    GlobalEventQueue,
    GlobalEventQueueListener,
    ListGlobalEventQueueOptions,
} from "./GlobalEventQueue.js";
import type { SessionDatabase } from "../persistence/database/openSessionDatabase.js";
import { durableGlobalEvents, durableGlobalEventState } from "../persistence/database/schema.js";
import { shouldPersistGlobalEventType } from "./shouldPersistGlobalEventType.js";

export class PersistentGlobalEventQueue implements GlobalEventQueue {
    readonly durable = true;
    readonly #database: SessionDatabase;
    readonly #closeListeners = new Set<() => void>();
    readonly #createCursor: () => EventId;
    readonly #listeners = new Set<GlobalEventQueueListener>();
    #head: EventId;
    #trimmedThrough: EventId | undefined;

    constructor(database: SessionDatabase, options: { resetStream?: boolean } = {}) {
        this.#database = database;
        if (options.resetStream === true) globalEventReset(this.#database);
        const latestCursor = this.#database
            .select({ cursor: max(durableGlobalEvents.cursor) })
            .from(durableGlobalEvents)
            .get()?.cursor;
        this.#trimmedThrough = this.#database
            .select({ cursor: durableGlobalEventState.trimmedThroughCursor })
            .from(durableGlobalEventState)
            .limit(1)
            .get()?.cursor;
        const seed =
            latestCursor === null || latestCursor === undefined
                ? this.#trimmedThrough
                : this.#trimmedThrough === undefined || latestCursor > this.#trimmedThrough
                  ? latestCursor
                  : this.#trimmedThrough;
        this.#createCursor = createEventIdFactory(seed === undefined ? {} : { after: seed });
        this.#head = seed ?? this.#createCursor();
    }

    append(event: GlobalEvent, tx: TX = this.#database): GlobalEventQueueEntry | undefined {
        if (isLiveGlobalEvent(event)) return undefined;
        if ("sessionId" in event && !shouldPersistGlobalEventType(event.type)) return undefined;
        let aggregate: { id: string; kind: "project" | "session" | "workspace" };
        if ("workspaceId" in event && typeof event.workspaceId === "string") {
            aggregate = { id: event.workspaceId, kind: "workspace" };
        } else if ("sessionId" in event && typeof event.sessionId === "string") {
            aggregate = { id: event.sessionId, kind: "session" };
        } else {
            aggregate = { id: (event as ProjectEvent).projectId, kind: "project" };
        }
        const cursor = this.#createCursor();
        const entry = globalEventAppend(tx, {
            aggregateId: aggregate.id,
            aggregateKind: aggregate.kind,
            cursor,
            event,
        });
        this.#head = cursor;
        return entry;
    }

    cursor(): string {
        return this.#head;
    }

    publish(entry: GlobalEventQueueEntry): void {
        for (const listener of this.#listeners) listener(entry);
    }

    publishLive(event: GlobalLiveEvent): boolean {
        // Identical to the in-memory queue: a live event is delivered and forgotten, so durable
        // retention never grows with Git activity.
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

    deactivate(): void {
        for (const listener of this.#closeListeners) listener();
        this.#closeListeners.clear();
        this.#listeners.clear();
    }

    list(options: ListGlobalEventQueueOptions = {}): readonly GlobalEventQueueEntry[] | undefined {
        const after = options.after?.toLowerCase();
        if (
            after !== undefined &&
            (!eventIdsShareScope(after, this.#head) ||
                after > this.#head ||
                (this.#trimmedThrough !== undefined && after < this.#trimmedThrough))
        ) {
            return undefined;
        }
        const query = this.#database
            .select({
                cursor: durableGlobalEvents.cursor,
                dataJson: durableGlobalEvents.dataJson,
            })
            .from(durableGlobalEvents)
            .orderBy(asc(durableGlobalEvents.cursor))
            .limit(options.limit ?? -1);
        const rows =
            after === undefined
                ? query.all()
                : query.where(gt(durableGlobalEvents.cursor, after)).all();
        return rows.map((row) => ({
            cursor: row.cursor,
            event: JSON.parse(row.dataJson) as GlobalEvent,
        }));
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
        if (!eventIdsShareScope(normalized, this.#head) || normalized > this.#head) {
            return undefined;
        }
        const trimmed = globalEventTrim(this.#database, normalized);
        if (this.#trimmedThrough === undefined || normalized > this.#trimmedThrough) {
            this.#trimmedThrough = normalized as EventId;
        }
        return { trimmed, through: normalized };
    }
}
