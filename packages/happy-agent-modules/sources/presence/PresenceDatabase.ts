import {
    agentDatabaseRows,
    agentDatabaseRun,
    type AgentModuleMigration,
} from "@slopus/happy-agent-base";
import { Value } from "@sinclair/typebox/value";
import { sql } from "drizzle-orm";
import type { Context } from "@steve.kite/stdlib";

import {
    presenceScheduleSchema,
    type PresenceSchedule,
    type PresenceScheduleInput,
} from "./PresenceSchedule.js";
import { presenceStateSchema, type PresenceState } from "./PresenceState.js";

export const PRESENCE_MIGRATION_KEY = "001-presence";
export const PRESENCE_RECEIPTS_REMOVED_MIGRATION_KEY = "002-remove-presence-receipts";

const PRESENCE_TABLE = "happy_agent_presence";
const SCHEDULE_TABLE = "happy_agent_presence_schedules";

export const presenceMigrations: readonly AgentModuleMigration[] = [
    [
        PRESENCE_MIGRATION_KEY,
        async (_ctx, database) => {
            await agentDatabaseRun(
                database,
                sql`CREATE TABLE IF NOT EXISTS happy_agent_presence (
                    singleton_id INTEGER PRIMARY KEY,
                    state_json TEXT NOT NULL
                )`,
            );
            await agentDatabaseRun(
                database,
                sql`CREATE TABLE IF NOT EXISTS happy_agent_presence_schedules (
                    id TEXT PRIMARY KEY,
                    schedule_json TEXT NOT NULL
                )`,
            );
            await agentDatabaseRun(
                database,
                sql`CREATE TABLE IF NOT EXISTS happy_agent_presence_receipts (
                    operation_id TEXT PRIMARY KEY,
                    kind TEXT NOT NULL,
                    fingerprint TEXT NOT NULL,
                    result_json TEXT NOT NULL
                )`,
            );
        },
    ],
    [
        PRESENCE_RECEIPTS_REMOVED_MIGRATION_KEY,
        async (_ctx, database) => {
            await agentDatabaseRun(
                database,
                sql`DROP TABLE IF EXISTS happy_agent_presence_receipts`,
            );
        },
    ],
];

export interface PresenceDatabase {
    readonly read: (ctx: Context, at: number) => Promise<PresenceState | undefined>;
    readonly readConfigured: (ctx: Context) => Promise<PresenceState | undefined>;
    readonly set: (ctx: Context, state: PresenceState) => Promise<void>;
    readonly clear: (ctx: Context) => Promise<void>;
    readonly schedules: {
        readonly list: (
            ctx: Context,
            options: { readonly limit: number },
        ) => Promise<readonly PresenceSchedule[]>;
        readonly set: (
            ctx: Context,
            input: PresenceScheduleInput,
            id: string,
        ) => Promise<PresenceSchedule>;
        readonly clear: (ctx: Context, id: string) => Promise<boolean>;
    };
}

export function createPresenceDatabase(): PresenceDatabase {
    const readConfigured = async (ctx: Context): Promise<PresenceState | undefined> => {
        const rows = await agentDatabaseRows<{ state_json: string }>(
            ctx.db,
            sql`SELECT state_json FROM ${sql.raw(PRESENCE_TABLE)}
                WHERE singleton_id = 1 LIMIT 1`,
        );
        if (rows[0] === undefined) return undefined;
        const value = parseJson(rows[0].state_json, "presence state");
        if (!Value.Check(presenceStateSchema, value)) {
            throw new Error("Presence database contains an invalid configured state.");
        }
        return structuredClone(value) as PresenceState;
    };

    const listSchedules = async (
        ctx: Context,
        options: { readonly limit: number },
    ): Promise<readonly PresenceSchedule[]> => {
        const rows = await agentDatabaseRows<{ schedule_json: string }>(
            ctx.db,
            sql`SELECT schedule_json FROM ${sql.raw(SCHEDULE_TABLE)}
                ORDER BY id LIMIT ${options.limit}`,
        );
        return rows.map((row) => {
            const value = parseJson(row.schedule_json, "presence schedule");
            if (!Value.Check(presenceScheduleSchema, value)) {
                throw new Error("Presence database contains an invalid schedule.");
            }
            return structuredClone(value) as PresenceSchedule;
        });
    };

    const schedules = {
        list: listSchedules,
        set: async (
            ctx: Context,
            input: PresenceScheduleInput,
            id: string,
        ): Promise<PresenceSchedule> => {
            const schedule = { id, ...structuredClone(input) };
            if (!Value.Check(presenceScheduleSchema, schedule)) {
                throw new Error("Presence database received an invalid schedule.");
            }
            await agentDatabaseRun(
                ctx.db,
                sql`INSERT INTO ${sql.raw(SCHEDULE_TABLE)} (id, schedule_json)
                    VALUES (${schedule.id}, ${JSON.stringify(schedule)})`,
            );
            return schedule as PresenceSchedule;
        },
        clear: async (ctx: Context, id: string): Promise<boolean> => {
            const rows = await agentDatabaseRows<{ id: string }>(
                ctx.db,
                sql`DELETE FROM ${sql.raw(SCHEDULE_TABLE)}
                    WHERE id = ${id}
                    RETURNING id`,
            );
            return rows.length > 0;
        },
    } as const;

    return {
        readConfigured,
        read: async (ctx, at) => {
            const configured = await readConfigured(ctx);
            if (configured !== undefined) {
                if (configured.effectiveFrom !== undefined && at < configured.effectiveFrom) {
                    return undefined;
                }
                if (configured.expiresAt !== undefined && at >= configured.expiresAt) {
                    return configured.fallback === undefined
                        ? undefined
                        : structuredClone(configured.fallback);
                }
                return configured;
            }
            return await effectiveSchedule(ctx, at, listSchedules);
        },
        set: async (ctx, state) => {
            await agentDatabaseRun(
                ctx.db,
                sql`INSERT INTO ${sql.raw(PRESENCE_TABLE)} (singleton_id, state_json)
                    VALUES (1, ${JSON.stringify(state)})
                    ON CONFLICT (singleton_id)
                    DO UPDATE SET state_json = EXCLUDED.state_json`,
            );
        },
        clear: async (ctx) => {
            await agentDatabaseRun(
                ctx.db,
                sql`DELETE FROM ${sql.raw(PRESENCE_TABLE)} WHERE singleton_id = 1`,
            );
        },
        schedules,
    };
}

async function effectiveSchedule(
    ctx: Context,
    at: number,
    list: (
        ctx: Context,
        options: { readonly limit: number },
    ) => Promise<readonly PresenceSchedule[]>,
): Promise<PresenceState | undefined> {
    const schedules = await list(ctx, { limit: 10_000 });
    const now = new Date(at);
    for (const schedule of schedules) {
        const parts = new Intl.DateTimeFormat("en-US", {
            timeZone: schedule.timeZone,
            weekday: "short",
            hour: "2-digit",
            minute: "2-digit",
            hourCycle: "h23",
        }).formatToParts(now);
        const weekday = parts.find((part) => part.type === "weekday")?.value;
        const hour = Number(parts.find((part) => part.type === "hour")?.value);
        const minute = Number(parts.find((part) => part.type === "minute")?.value);
        const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(weekday ?? "");
        if (!schedule.days.includes(day)) continue;
        const current = hour * 60 + minute;
        const start = minutes(schedule.startTime);
        const end = minutes(schedule.endTime);
        const active =
            start <= end ? current >= start && current < end : current >= start || current < end;
        if (active) return structuredClone(schedule.presence);
    }
    return undefined;
}

function minutes(value: string): number {
    return Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
}

function parseJson(value: string, label: string): unknown {
    try {
        return JSON.parse(value) as unknown;
    } catch {
        throw new Error(`Presence database ${label} is not valid JSON.`);
    }
}
