import type { DatabaseSync } from "node:sqlite";

import { createId } from "@paralleldrive/cuid2";
import { isLiveGlobalEvent } from "../protocol/index.js";

import type {
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
import { shouldPersistGlobalEventType } from "./shouldPersistGlobalEventType.js";

export function initializePersistentGlobalEventQueueSchema(database: DatabaseSync): void {
    database.exec(`
        CREATE TABLE IF NOT EXISTS durable_global_events (
            position INTEGER NOT NULL,
            stream_id TEXT NOT NULL,
            event_id TEXT NOT NULL UNIQUE,
            aggregate_kind TEXT NOT NULL,
            aggregate_id TEXT NOT NULL,
            type TEXT NOT NULL,
            created_at_ms INTEGER NOT NULL,
            data_json TEXT NOT NULL,
            PRIMARY KEY (stream_id, position)
        );

        CREATE TABLE IF NOT EXISTS durable_global_event_streams (
            stream_id TEXT PRIMARY KEY,
            last_position INTEGER NOT NULL,
            trimmed_through INTEGER NOT NULL,
            created_at_ms INTEGER NOT NULL
        );
    `);
}

export class PersistentGlobalEventQueue implements GlobalEventQueue {
    readonly durable = true;
    readonly #database: DatabaseSync;
    readonly #closeListeners = new Set<() => void>();
    readonly #listeners = new Set<GlobalEventQueueListener>();
    readonly #streamId: string;

    constructor(database: DatabaseSync, options: { resetStream?: boolean } = {}) {
        this.#database = database;
        this.#initialize();
        if (options.resetStream === true) {
            this.#database.exec(`
                DELETE FROM durable_global_events;
                DELETE FROM durable_global_event_streams;
            `);
        }
        const latest = this.#database
            .prepare(
                "SELECT stream_id FROM durable_global_event_streams ORDER BY created_at_ms DESC LIMIT 1",
            )
            .get();
        this.#streamId =
            latest === undefined ? this.#createStream() : readString(latest, "stream_id");
    }

    append(event: GlobalEvent): GlobalEventQueueEntry | undefined {
        if (isLiveGlobalEvent(event)) return undefined;
        if ("sessionId" in event && !shouldPersistGlobalEventType(event.type)) return undefined;
        const state = this.#state();
        const position = state.lastPosition + 1;
        let aggregate: { id: string; kind: "project" | "session" | "workspace" };
        if ("workspaceId" in event && typeof event.workspaceId === "string") {
            aggregate = { id: event.workspaceId, kind: "workspace" };
        } else if ("sessionId" in event && typeof event.sessionId === "string") {
            aggregate = { id: event.sessionId, kind: "session" };
        } else {
            aggregate = { id: (event as ProjectEvent).projectId, kind: "project" };
        }
        this.#database
            .prepare(
                `
                INSERT INTO durable_global_events (
                    position, stream_id, event_id, aggregate_kind, aggregate_id,
                    type, created_at_ms, data_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                `,
            )
            .run(
                position,
                this.#streamId,
                event.id,
                aggregate.kind,
                aggregate.id,
                event.type,
                event.createdAt,
                JSON.stringify(event),
            );
        this.#database
            .prepare(
                "UPDATE durable_global_event_streams SET last_position = ? WHERE stream_id = ?",
            )
            .run(position, this.#streamId);
        return { cursor: this.#cursor(position), event };
    }

    cursor(): string {
        return this.#cursor(this.#state().lastPosition);
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
        const state = this.#state();
        const after =
            options.after === undefined ? state.trimmedThrough : this.#position(options.after);
        if (after === undefined || after < state.trimmedThrough || after > state.lastPosition) {
            return undefined;
        }
        const limitClause = options.limit === undefined ? "" : "LIMIT ?";
        const values = [
            this.#streamId,
            after,
            ...(options.limit === undefined ? [] : [options.limit]),
        ];
        return this.#database
            .prepare(
                `
                SELECT position, data_json
                FROM durable_global_events
                WHERE stream_id = ? AND position > ?
                ORDER BY position ASC
                ${limitClause}
                `,
            )
            .all(...values)
            .map((row) => ({
                cursor: this.#cursor(readNumber(row, "position")),
                event: JSON.parse(readString(row, "data_json")) as GlobalEvent,
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
        const position = this.#position(through);
        const state = this.#state();
        if (position === undefined || position > state.lastPosition) return undefined;
        if (position <= state.trimmedThrough) return { trimmed: 0, through };
        this.#database.exec("BEGIN IMMEDIATE");
        try {
            const result = this.#database
                .prepare("DELETE FROM durable_global_events WHERE stream_id = ? AND position <= ?")
                .run(this.#streamId, position);
            this.#database
                .prepare(
                    "UPDATE durable_global_event_streams SET trimmed_through = ? WHERE stream_id = ?",
                )
                .run(position, this.#streamId);
            this.#database.exec("COMMIT");
            return { trimmed: Number(result.changes), through };
        } catch (error) {
            this.#database.exec("ROLLBACK");
            throw error;
        }
    }

    #initialize(): void {
        initializePersistentGlobalEventQueueSchema(this.#database);
    }

    #createStream(): string {
        const streamId = createId();
        this.#database
            .prepare(
                `
                INSERT INTO durable_global_event_streams (
                    stream_id, last_position, trimmed_through, created_at_ms
                ) VALUES (?, 0, 0, ?)
                `,
            )
            .run(streamId, Date.now());
        return streamId;
    }

    #state(): { lastPosition: number; trimmedThrough: number } {
        const row = this.#database
            .prepare(
                `
                SELECT last_position, trimmed_through
                FROM durable_global_event_streams
                WHERE stream_id = ?
                `,
            )
            .get(this.#streamId);
        if (row === undefined)
            throw new Error("The durable global event queue is not initialized.");
        return {
            lastPosition: readNumber(row, "last_position"),
            trimmedThrough: readNumber(row, "trimmed_through"),
        };
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

function readNumber(row: Record<string, unknown>, key: string): number {
    const value = row[key];
    if (typeof value === "number") return value;
    if (typeof value === "bigint") return Number(value);
    throw new Error(`Expected numeric SQLite column '${key}'.`);
}

function readString(row: Record<string, unknown>, key: string): string {
    const value = row[key];
    if (typeof value === "string") return value;
    throw new Error(`Expected text SQLite column '${key}'.`);
}
