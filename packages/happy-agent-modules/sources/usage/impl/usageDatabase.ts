import { sql } from "drizzle-orm";
import { agentDatabaseRows, agentDatabaseRun } from "@slopus/happy-agent-base";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";

import {
    MAX_USAGE_RECORDS,
    usageAggregateQuerySchema,
    usagePageQuerySchema,
    usagePageSchema,
    usageSummarySchema,
    type UsageAggregateQuery,
    type UsagePage,
    type UsagePageQuery,
    type UsageRecord,
    type UsageSummary,
} from "../Usage.js";
import { assertUsageRecord } from "./assertUsageRecord.js";

const RECORDS_TABLE = "happy_agent_usage_records";

export class UsageDatabase {
    async read(
        ctx: Context,
        agentId: string,
        query: UsagePageQuery,
        maxPageSize: number,
    ): Promise<UsagePage> {
        if (!Value.Check(usagePageQuerySchema, query)) {
            throw new Error("Usage page query is invalid.");
        }
        const cursor = query.cursor ?? 0;
        const limit = query.limit ?? maxPageSize;
        const rows = await agentDatabaseRows<{ record_json: string; total: number | string }>(
            ctx.db,
            sql`SELECT record_json,
                       (SELECT COUNT(*) FROM ${sql.raw(RECORDS_TABLE)}
                        WHERE agent_id = ${agentId}) AS total
                FROM ${sql.raw(RECORDS_TABLE)}
                WHERE agent_id = ${agentId}
                ORDER BY finished_at, record_id
                LIMIT ${limit + 1} OFFSET ${cursor}`,
        );
        const records = rows.slice(0, limit).map((row) => this.#parseRecord(row.record_json));
        const totalRecords = Number(rows[0]?.total ?? 0);
        const page: UsagePage = {
            agentId,
            records,
            cursor,
            totalRecords: Math.min(MAX_USAGE_RECORDS, totalRecords),
            ...(cursor + records.length < totalRecords
                ? { nextCursor: cursor + records.length }
                : {}),
        };
        if (!Value.Check(usagePageSchema, page)) {
            throw new Error("Usage database returned an invalid page.");
        }
        return structuredClone(page);
    }

    /**
     * Lifetime tokens per agent, in one pass over the bounded record table.
     *
     * A subtree snapshot needs a number for every agent in it, and asking per agent would read
     * the same five hundred rows once per agent. An agent with no records is simply absent.
     */
    async totalTokensByAgent(ctx: Context): Promise<ReadonlyMap<string, number>> {
        const rows = await agentDatabaseRows<{ record_json: string }>(
            ctx.db,
            sql`SELECT record_json
                FROM ${sql.raw(RECORDS_TABLE)}
                ORDER BY finished_at, record_id
                LIMIT ${MAX_USAGE_RECORDS}`,
        );
        const totals = new Map<string, number>();
        for (const row of rows) {
            const record = this.#parseRecord(row.record_json);
            if (record.kind !== "inference") continue;
            const previous = totals.get(record.agentId) ?? 0;
            totals.set(record.agentId, previous + record.tokens.input + record.tokens.output);
        }
        return totals;
    }

    async aggregate(
        ctx: Context,
        query: UsageAggregateQuery,
        maxGroups: number,
    ): Promise<UsageSummary> {
        if (!Value.Check(usageAggregateQuerySchema, query)) {
            throw new Error("Usage aggregate query is invalid.");
        }
        const rows = await agentDatabaseRows<{ record_json: string }>(
            ctx.db,
            query.agentId === undefined
                ? sql`SELECT record_json
                      FROM ${sql.raw(RECORDS_TABLE)}
                      ORDER BY finished_at, record_id
                      LIMIT ${MAX_USAGE_RECORDS}`
                : sql`SELECT record_json
                      FROM ${sql.raw(RECORDS_TABLE)}
                      WHERE agent_id = ${query.agentId}
                      ORDER BY finished_at, record_id
                      LIMIT ${MAX_USAGE_RECORDS}`,
        );
        const records = rows.map((row) => this.#parseRecord(row.record_json));
        const groups = new Map<string, UsageSummary["groups"][number]>();
        for (const record of records) {
            const key = JSON.stringify([
                record.provider,
                record.model ?? null,
                record.effort ?? null,
                record.tier ?? null,
            ]);
            const previous = groups.get(key);
            const next =
                previous === undefined
                    ? {
                          provider: record.provider,
                          ...(record.model === undefined ? {} : { model: record.model }),
                          ...(record.effort === undefined ? {} : { effort: record.effort }),
                          ...(record.tier === undefined ? {} : { tier: record.tier }),
                          inferenceCount: 0,
                          turnCount: 0,
                          inputTokens: 0,
                          outputTokens: 0,
                          totalTokens: 0,
                          inferenceDurationMs: 0,
                          turnDurationMs: 0,
                          totalDurationMs: 0,
                      }
                    : { ...previous };
            if (record.kind === "inference") {
                next.inferenceCount += 1;
                next.inputTokens += record.tokens.input;
                next.outputTokens += record.tokens.output;
                next.totalTokens += record.tokens.input + record.tokens.output;
                next.inferenceDurationMs += record.durationMs;
            } else {
                next.turnCount += 1;
                next.turnDurationMs += record.durationMs;
            }
            next.totalDurationMs = next.inferenceDurationMs + next.turnDurationMs;
            groups.set(key, next);
        }
        const allGroups = [...groups.values()];
        const cursor = query.cursor ?? 0;
        const page = allGroups.slice(cursor, cursor + maxGroups);
        let latestTurn: Extract<UsageRecord, { kind: "turn" }> | undefined;
        for (const record of records) {
            if (record.kind === "turn") latestTurn = record;
        }
        const currentContext =
            latestTurn?.contextTokens === undefined
                ? undefined
                : {
                      approximate: false,
                      contextTokens: latestTurn.contextTokens,
                      provider: latestTurn.provider,
                      ...(latestTurn.model === undefined ? {} : { model: latestTurn.model }),
                      ...(latestTurn.effort === undefined ? {} : { effort: latestTurn.effort }),
                      ...(latestTurn.tier === undefined ? {} : { tier: latestTurn.tier }),
                  };
        const summary: UsageSummary = {
            ...(query.agentId === undefined ? {} : { agentId: query.agentId }),
            cursor,
            totalGroups: allGroups.length,
            inferenceCount: records.filter((record) => record.kind === "inference").length,
            turnCount: records.filter((record) => record.kind === "turn").length,
            inputTokens: records.reduce(
                (sum, record) => sum + (record.kind === "inference" ? record.tokens.input : 0),
                0,
            ),
            outputTokens: records.reduce(
                (sum, record) => sum + (record.kind === "inference" ? record.tokens.output : 0),
                0,
            ),
            totalTokens: records.reduce(
                (sum, record) =>
                    sum +
                    (record.kind === "inference" ? record.tokens.input + record.tokens.output : 0),
                0,
            ),
            inferenceDurationMs: records.reduce(
                (sum, record) => sum + (record.kind === "inference" ? record.durationMs : 0),
                0,
            ),
            turnDurationMs: records.reduce(
                (sum, record) => sum + (record.kind === "turn" ? record.durationMs : 0),
                0,
            ),
            totalDurationMs: records.reduce((sum, record) => sum + record.durationMs, 0),
            ...(currentContext === undefined ? {} : { currentContext }),
            groups: page,
            ...(cursor + page.length < allGroups.length
                ? { nextCursor: cursor + page.length }
                : {}),
        };
        if (!Value.Check(usageSummarySchema, summary)) {
            throw new Error("Usage database returned an invalid aggregate.");
        }
        return structuredClone(summary);
    }

    async record(ctx: Context, record: UsageRecord): Promise<void> {
        assertUsageRecord(record);
        await agentDatabaseRun(
            ctx.db,
            sql`INSERT INTO ${sql.raw(RECORDS_TABLE)}
                    (record_id, agent_id, finished_at, kind, record_json)
                VALUES (${record.id}, ${record.agentId}, ${record.finishedAt}, ${record.kind}, ${JSON.stringify(record)})`,
        );
        await agentDatabaseRun(
            ctx.db,
            sql`DELETE FROM ${sql.raw(RECORDS_TABLE)}
                WHERE record_id IN (
                    SELECT record_id FROM ${sql.raw(RECORDS_TABLE)}
                    ORDER BY finished_at DESC, record_id DESC
                    LIMIT 9223372036854775807 OFFSET ${MAX_USAGE_RECORDS}
                )`,
        );
    }

    async reset(ctx: Context, agentId: string | null): Promise<number> {
        const rows = await agentDatabaseRows<{ count: number | string }>(
            ctx.db,
            agentId === null
                ? sql`SELECT COUNT(*) AS count FROM ${sql.raw(RECORDS_TABLE)}`
                : sql`SELECT COUNT(*) AS count FROM ${sql.raw(RECORDS_TABLE)}
                      WHERE agent_id = ${agentId}`,
        );
        const count = Math.min(MAX_USAGE_RECORDS, Number(rows[0]?.count ?? 0));
        await agentDatabaseRun(
            ctx.db,
            agentId === null
                ? sql`DELETE FROM ${sql.raw(RECORDS_TABLE)}`
                : sql`DELETE FROM ${sql.raw(RECORDS_TABLE)} WHERE agent_id = ${agentId}`,
        );
        return count;
    }

    #parseRecord(encoded: string): UsageRecord {
        const value: unknown = JSON.parse(encoded);
        assertUsageRecord(value);
        return structuredClone(value);
    }
}
