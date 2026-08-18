import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
    agentDatabaseRows,
    agentDatabaseRun,
    type AgentDatabase,
    type AgentModuleMigration,
} from "@slopus/happy-agent-base";
import { sql } from "drizzle-orm";

import {
    appendEventInputSchema,
    eventIdSchema,
    eventSchema,
    type AgentEvent,
    type AppendEventInput,
} from "./types.js";

const MAX_EVENT_PAYLOAD_BYTES = 5 * 1_024 * 1_024;

/**
 * A structured clone keeps a key whose value is `undefined`; JSON drops it. Payloads are recorded
 * as clones, so the durable form tags those values and restores them on the way back rather than
 * quietly losing a key the recorder set.
 */
const UNDEFINED_TAG = "$happyUndefined";

const eventRowSchema = Type.Object(
    {
        agent_id: Type.Union([Type.String(), Type.Null()]),
        event_id: Type.String(),
        occurred_at: Type.Integer(),
        payload_json: Type.String(),
        type: Type.String(),
    },
    { additionalProperties: false },
);
type EventRow = Static<typeof eventRowSchema>;

const stateRowSchema = Type.Object(
    {
        key: Type.String(),
        value: Type.String(),
    },
    { additionalProperties: false },
);
type StateRow = Static<typeof stateRowSchema>;

export const eventsMigrations: readonly AgentModuleMigration[] = [
    [
        "001-durable-events",
        async (_ctx, database) => {
            await agentDatabaseRun(
                database,
                sql`CREATE TABLE IF NOT EXISTS happy_agent_events (
                    event_id TEXT PRIMARY KEY,
                    agent_id TEXT,
                    occurred_at INTEGER NOT NULL,
                    type TEXT NOT NULL,
                    payload_json TEXT NOT NULL
                )`,
            );
            await agentDatabaseRun(
                database,
                sql`CREATE INDEX IF NOT EXISTS happy_agent_events_agent_id_event_id
                    ON happy_agent_events(agent_id, event_id)`,
            );
            await agentDatabaseRun(
                database,
                sql`CREATE TABLE IF NOT EXISTS happy_agent_event_state (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                )`,
            );
            await agentDatabaseRun(
                database,
                sql`CREATE TABLE IF NOT EXISTS happy_agent_active_runs (
                    agent_id TEXT PRIMARY KEY,
                    state_json TEXT NOT NULL
                )`,
            );
        },
    ],
];

export async function loadEventState(
    database: AgentDatabase,
    capacity: number,
): Promise<{
    readonly events: readonly AgentEvent[];
    readonly originCursor?: string;
}> {
    const rows = await agentDatabaseRows<EventRow>(
        database,
        sql`SELECT event_id, agent_id, occurred_at, type, payload_json
            FROM happy_agent_events ORDER BY event_id DESC LIMIT ${capacity}`,
    );
    const state = await agentDatabaseRows<StateRow>(
        database,
        sql`SELECT key, value FROM happy_agent_event_state WHERE key = 'origin_cursor'`,
    );
    const storedOrigin = state[0]?.value;
    if (storedOrigin !== undefined && !Value.Check(eventIdSchema, storedOrigin)) {
        throw new Error("The durable agent event origin cursor is invalid.");
    }
    const events = [...rows].reverse().map(eventFromRow);
    let previousOccurredAt = 0;
    for (const event of events) {
        if (event.occurredAt < previousOccurredAt) {
            throw new Error("The durable agent events are not ordered in time.");
        }
        previousOccurredAt = event.occurredAt;
    }
    const first = events[0];
    if (first === undefined) {
        return storedOrigin === undefined ? { events } : { events, originCursor: storedOrigin };
    }
    if (storedOrigin === undefined) {
        throw new Error("The durable agent event origin cursor is missing.");
    }
    // A smaller configured capacity leaves durable events below the retained window. The origin is
    // the newest of those, so a replay from the origin describes exactly what is still here.
    const dropped = await agentDatabaseRows<{ event_id: string }>(
        database,
        sql`SELECT event_id FROM happy_agent_events
            WHERE event_id < ${first.id} ORDER BY event_id DESC LIMIT 1`,
    );
    const originCursor = dropped[0]?.event_id ?? storedOrigin;
    if (originCursor >= first.id) {
        throw new Error("The durable agent event origin cursor is inside the retained window.");
    }
    return { events, originCursor };
}

export async function loadActiveRuns<State>(
    database: AgentDatabase,
    parse: (value: unknown) => State,
): Promise<ReadonlyMap<string, State>> {
    const rows = await agentDatabaseRows<{ agent_id: string; state_json: string }>(
        database,
        sql`SELECT agent_id, state_json FROM happy_agent_active_runs`,
    );
    return new Map(rows.map((row) => [row.agent_id, parse(deserializePayload(row.state_json))]));
}

/**
 * The run of one agent as the current transaction sees it, so work committing together shares one
 * run identity even before that transaction's post-commit state lands.
 */
export async function loadActiveRun<State>(
    database: AgentDatabase,
    agentId: string,
    parse: (value: unknown) => State,
): Promise<State | undefined> {
    const rows = await agentDatabaseRows<{ state_json: string }>(
        database,
        sql`SELECT state_json FROM happy_agent_active_runs WHERE agent_id = ${agentId} LIMIT 1`,
    );
    const row = rows[0];
    return row === undefined ? undefined : parse(deserializePayload(row.state_json));
}

export async function insertEvent(
    database: AgentDatabase,
    event: AgentEvent,
    capacity: number,
): Promise<void> {
    const payload = serializePayload(event.payload);
    await agentDatabaseRun(
        database,
        sql`INSERT INTO happy_agent_events (
                event_id, agent_id, occurred_at, type, payload_json
            ) VALUES (
                ${event.id}, ${event.agentId ?? null}, ${event.occurredAt}, ${event.type}, ${payload}
            )`,
    );
    const removed = await agentDatabaseRows<{ event_id: string }>(
        database,
        sql`SELECT event_id FROM happy_agent_events
            ORDER BY event_id DESC LIMIT -1 OFFSET ${capacity}`,
    );
    const through = removed[0]?.event_id;
    if (through === undefined) return;
    await agentDatabaseRun(
        database,
        sql`DELETE FROM happy_agent_events WHERE event_id <= ${through}`,
    );
    await saveState(database, "origin_cursor", through);
}

export async function trimEvents(
    database: AgentDatabase,
    through: string,
): Promise<number | undefined> {
    const exact = await agentDatabaseRows<{ event_id: string }>(
        database,
        sql`SELECT event_id FROM happy_agent_events WHERE event_id = ${through} LIMIT 1`,
    );
    if (exact.length === 0) return undefined;
    const rows = await agentDatabaseRows<{ count: number | string }>(
        database,
        sql`SELECT COUNT(*) AS count FROM happy_agent_events WHERE event_id <= ${through}`,
    );
    const count = Number(rows[0]?.count ?? 0);
    if (count === 0) return undefined;
    await agentDatabaseRun(
        database,
        sql`DELETE FROM happy_agent_events WHERE event_id <= ${through}`,
    );
    await saveState(database, "origin_cursor", through);
    return count;
}

export async function saveOriginCursor(database: AgentDatabase, cursor: string): Promise<void> {
    await agentDatabaseRun(
        database,
        sql`INSERT INTO happy_agent_event_state (key, value)
            VALUES ('origin_cursor', ${cursor}) ON CONFLICT(key) DO NOTHING`,
    );
}

export async function saveActiveRun(
    database: AgentDatabase,
    agentId: string,
    state: unknown,
): Promise<void> {
    const encoded = serializePayload(state);
    await agentDatabaseRun(
        database,
        sql`INSERT INTO happy_agent_active_runs (agent_id, state_json)
            VALUES (${agentId}, ${encoded})
            ON CONFLICT(agent_id) DO UPDATE SET state_json = excluded.state_json`,
    );
}

export async function deleteActiveRun(database: AgentDatabase, agentId: string): Promise<void> {
    await agentDatabaseRun(
        database,
        sql`DELETE FROM happy_agent_active_runs WHERE agent_id = ${agentId}`,
    );
}

function eventFromRow(input: unknown): AgentEvent {
    if (!Value.Check(eventRowSchema, input)) throw new Error("A durable agent event is invalid.");
    const event = {
        ...(input.agent_id === null ? {} : { agentId: input.agent_id }),
        id: input.event_id,
        occurredAt: input.occurred_at,
        payload: deserializePayload(input.payload_json),
        type: input.type,
    };
    if (!Value.Check(eventSchema, event)) {
        throw new Error("A durable agent event payload is invalid.");
    }
    return event;
}

function serializePayload(payload: unknown): string {
    let encoded: string | undefined;
    try {
        encoded = JSON.stringify(payload, (_key, value: unknown) =>
            value === undefined
                ? { [UNDEFINED_TAG]: true }
                : typeof value === "bigint"
                  ? value.toString()
                  : value,
        );
    } catch {
        throw new Error("The agent event payload must be JSON serializable.");
    }
    if (encoded === undefined || Buffer.byteLength(encoded, "utf8") > MAX_EVENT_PAYLOAD_BYTES) {
        throw new Error("The agent event payload exceeds the 5 MiB durable limit.");
    }
    return encoded;
}

function deserializePayload(encoded: string): unknown {
    if (Buffer.byteLength(encoded, "utf8") > MAX_EVENT_PAYLOAD_BYTES) {
        throw new Error("The agent event payload exceeds the 2 MiB durable limit.");
    }
    return restoreUndefined(JSON.parse(encoded));
}

function restoreUndefined(value: unknown): unknown {
    if (Array.isArray(value)) {
        const items = value as unknown[];
        for (let index = 0; index < items.length; index += 1) {
            items[index] = restoreUndefined(items[index]);
        }
        return items;
    }
    if (value === null || typeof value !== "object") return value;
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    if (keys.length === 1 && record[UNDEFINED_TAG] === true) return undefined;
    for (const key of keys) record[key] = restoreUndefined(record[key]);
    return record;
}

async function saveState(database: AgentDatabase, key: string, value: string): Promise<void> {
    await agentDatabaseRun(
        database,
        sql`INSERT INTO happy_agent_event_state (key, value) VALUES (${key}, ${value})
            ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    );
}

export function validateAppendEvent(input: AppendEventInput): void {
    if (!Value.Check(appendEventInputSchema, input)) {
        throw new Error("The event input is invalid.");
    }
    serializePayload(input.payload);
}
