import {
    agentDatabaseRun,
    type AgentModuleScope,
    withAgentContext,
} from "@slopus/happy-agent-base";
import { withAfterCommit, type Context } from "@steve.kite/stdlib";
import { sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

import {
    MAX_USAGE_GROUPS,
    MAX_USAGE_OUTPUT_CHARACTERS,
    MAX_USAGE_RECORDS,
    type UsageAgentTree,
    type UsageInferenceRecord,
    type UsageSummary,
    type UsageTurnRecord,
} from "../../sources/usage/Usage.js";
import { UsageModule } from "../../sources/usage/UsageModule.js";
import { UsageDatabase } from "../../sources/usage/impl/usageDatabase.js";
import type { UsageEvent } from "../../sources/usage/UsageEvent.js";
import { getAgentTreeUsageTool } from "../../sources/usage/tools/get_agent_tree_usage.js";
import { getUsageTool } from "../../sources/usage/tools/get_usage.js";
import { moduleDatabase, type ModuleDatabase } from "../support/moduleDatabase.js";
import { resolveModuleHooks } from "../support/moduleHooks.js";

class FakeKV {
    readonly values = new Map<string, unknown>();

    async read(_ctx: Context, key: string): Promise<unknown> {
        return structuredClone(this.values.get(key));
    }

    async write(_ctx: Context, key: string, value: unknown): Promise<void> {
        this.values.set(key, structuredClone(value));
    }

    async delete(_ctx: Context, key: string): Promise<void> {
        this.values.delete(key);
    }
}

type UsageDatabaseHandle = ModuleDatabase & {
    readonly database: import("@slopus/happy-agent-base").AgentDatabase;
};

async function withUsageDatabase<T>(
    name: string,
    callback: (database: UsageDatabaseHandle) => Promise<T>,
): Promise<T> {
    const database = moduleDatabase([], name) as UsageDatabaseHandle;
    const module = new UsageModule({});
    try {
        for (const [, migration] of module.migrations) {
            await migration(database.context, database.database);
        }
        return await callback(database);
    } finally {
        database.close();
    }
}

function makeScope(
    database: UsageDatabaseHandle["database"],
    runKV = new FakeKV(),
    overrides: Record<string, unknown> = {},
): AgentModuleScope {
    return {
        database,
        agent: {
            id: "agent-1",
            provider: "provider-main",
            providerKind: "codex",
            model: "model-main",
            effort: "high",
            tier: "priority",
            permissionMode: "auto",
            ...overrides,
        },
        kv: new FakeKV(),
        sharedKV: new FakeKV(),
        runKV,
    } as never;
}

async function runWithAfterCommit<T>(
    ctx: Context,
    callback: (txCtx: Context) => Promise<T>,
): Promise<T> {
    const [txCtx, drain] = withAfterCommit(ctx);
    const result = await callback(txCtx);
    await drain();
    return result;
}

function inferenceRecord(
    id: string,
    agentId: string,
    finishedAt: number,
    overrides: Partial<UsageInferenceRecord> = {},
): UsageInferenceRecord {
    const startedAt = overrides.startedAt ?? finishedAt - 10;
    return {
        id,
        agentId,
        provider: "provider-main",
        model: "model-main",
        effort: "high",
        tier: "priority",
        kind: "inference",
        state: "normal",
        tokens: { input: 3, output: 2 },
        startedAt,
        finishedAt,
        durationMs: finishedAt - startedAt,
        ...overrides,
    };
}

function turnRecord(
    id: string,
    agentId: string,
    finishedAt: number,
    overrides: Partial<UsageTurnRecord> = {},
): UsageTurnRecord {
    const startedAt = overrides.startedAt ?? finishedAt - 10;
    return {
        id,
        agentId,
        provider: "provider-main",
        model: "model-main",
        effort: "high",
        tier: "priority",
        kind: "turn",
        aborted: false,
        contextTokens: 25,
        startedAt,
        finishedAt,
        durationMs: finishedAt - startedAt,
        ...overrides,
    };
}

async function insertRawRecord(
    database: UsageDatabaseHandle,
    record: UsageInferenceRecord | UsageTurnRecord,
): Promise<void> {
    await agentDatabaseRun(
        database.database,
        sql`INSERT INTO happy_agent_usage_records
            (record_id, agent_id, finished_at, kind, record_json)
            VALUES (${record.id}, ${record.agentId}, ${record.finishedAt}, ${record.kind}, ${JSON.stringify(record)})`,
    );
}

function agentContext(ctx: Context, id = "agent-1"): Context {
    return withAgentContext(ctx, {
        id,
        provider: "provider-main",
        model: "model-main",
        effort: "high",
        serviceTier: "priority",
        permissionMode: "auto",
    });
}

function tree(rootId = "agent-1"): UsageAgentTree {
    return {
        sessions: [
            {
                agentId: rootId,
                modelId: "model-main",
                path: "/root",
                providerId: "provider-main",
                relation: "root",
                status: "running",
                totalTokens: 10,
            },
            {
                agentId: "agent-2",
                modelId: "model-sub",
                parentAgentId: rootId,
                path: "/root/sub",
                providerId: "provider-main",
                relation: "subagent",
                status: "completed",
                totalTokens: 7,
            },
        ],
        totalTokens: 17,
    };
}

describe("UsageModule edge cases", () => {
    it("preserves provider attribution, error state, and aborted turn fields", async () => {
        await withUsageDatabase("usage-attribution-fields", async (database) => {
            let now = 100;
            const module = new UsageModule({ clock: () => now });
            const hooks = await resolveModuleHooks(database.context, module);
            const runKV = new FakeKV();
            const scope = makeScope(database.database, runKV);

            await hooks.beforeInferenceTransact!(database.context, scope, {
                loopId: "loop",
                turnId: "turn",
                inferenceId: "inference",
                contextTokens: undefined,
            });
            now = 140;
            await runWithAfterCommit(database.context, async (txCtx) => {
                await hooks.afterInferenceTransact!(txCtx, scope, {
                    loopId: "loop",
                    turnId: "turn",
                    inferenceId: "inference",
                    contextTokens: undefined,
                    state: "error",
                    errorMessage: "provider failed",
                    tokens: { input: 9, output: 2 },
                });
            });

            await hooks.beforeTurnTransact!(database.context, scope, {
                loopId: "loop",
                turnId: "turn",
                contextTokens: undefined,
            });
            now = 150;
            await runWithAfterCommit(database.context, async (txCtx) => {
                await hooks.afterTurnTransact!(txCtx, scope, {
                    loopId: "loop",
                    turnId: "turn",
                    contextTokens: 0,
                    aborted: true,
                });
            });

            await expect(
                database.context.inTx(async (ctx) => module.readPage(ctx, "agent-1")),
            ).resolves.toMatchObject({
                records: [
                    {
                        id: "inference",
                        provider: "provider-main",
                        model: "model-main",
                        effort: "high",
                        tier: "priority",
                        state: "error",
                        errorMessage: "provider failed",
                        durationMs: 40,
                    },
                    {
                        id: "turn",
                        aborted: true,
                        contextTokens: 0,
                        durationMs: 10,
                    },
                ],
            });
        });
    });

    it("treats missing provider tokens as an advisory observation failure and clears pending state", async () => {
        await withUsageDatabase("usage-missing-tokens", async (database) => {
            const report = vi.fn(async () => undefined);
            let now = 100;
            const module = new UsageModule({
                clock: () => now,
                onObserverError: report,
            });
            const hooks = await resolveModuleHooks(database.context, module);
            const runKV = new FakeKV();
            const scope = makeScope(database.database, runKV);

            await hooks.beforeInferenceTransact!(database.context, scope, {
                loopId: "loop",
                turnId: "turn",
                inferenceId: "missing",
                contextTokens: undefined,
            });
            now = 110;
            await runWithAfterCommit(database.context, async (txCtx) => {
                await hooks.afterInferenceTransact!(txCtx, scope, {
                    loopId: "loop",
                    turnId: "turn",
                    inferenceId: "missing",
                    contextTokens: undefined,
                    state: "normal",
                    tokens: undefined,
                });
            });

            expect(runKV.values).toEqual(new Map());
            expect((await module.readPage(database.context, "agent-1")).records).toEqual([]);
            expect(report).toHaveBeenCalledWith(
                expect.anything(),
                "after_inference",
                expect.stringContaining("token"),
            );
        });
    });

    it("rejects clocks that move backward or exceed duration bounds without failing the turn", async () => {
        await withUsageDatabase("usage-clock-errors", async (database) => {
            const report = vi.fn(async () => undefined);
            let now = 200;
            const module = new UsageModule({ clock: () => now, onObserverError: report });
            const hooks = await resolveModuleHooks(database.context, module);
            const scope = makeScope(database.database);

            await hooks.beforeTurnTransact!(database.context, scope, {
                loopId: "loop",
                turnId: "turn",
                contextTokens: undefined,
            });
            now = 100;
            await runWithAfterCommit(database.context, async (txCtx) => {
                await hooks.afterTurnTransact!(txCtx, scope, {
                    loopId: "loop",
                    turnId: "turn",
                    contextTokens: undefined,
                    aborted: false,
                });
            });

            expect((await module.readPage(database.context, "agent-1")).records).toEqual([]);
            expect(report).toHaveBeenCalledWith(
                expect.anything(),
                "after_turn",
                expect.stringContaining("backwards"),
            );
        });
    });

    it("survives a fresh module instance and rejects malformed JSON at the persistence boundary", async () => {
        await withUsageDatabase("usage-reload-and-malformed-json", async (database) => {
            await insertRawRecord(database, inferenceRecord("reload", "agent-1", 10));
            const fresh = new UsageModule({});
            await expect(fresh.readPage(database.context, "agent-1")).resolves.toMatchObject({
                totalRecords: 1,
                records: [{ id: "reload" }],
            });

            await agentDatabaseRun(
                database.database,
                sql`UPDATE happy_agent_usage_records
                    SET record_json = '{malformed'
                    WHERE record_id = 'reload'`,
            );
            await expect(fresh.readPage(database.context, "agent-1")).rejects.toThrow();
            await expect(
                fresh.aggregate(database.context, { agentId: "agent-1" }),
            ).rejects.toThrow();
        });
    });

    it("rejects semantically invalid persisted duration from raw-page reads", async () => {
        await withUsageDatabase("usage-invalid-persisted-duration", async (database) => {
            const invalid = inferenceRecord("invalid-duration", "agent-1", 20, {
                durationMs: 999,
            });
            await insertRawRecord(database, invalid);
            await expect(new UsageModule({}).readPage(database.context, "agent-1")).rejects.toThrow(
                "duration",
            );
        });
    });

    it("rejects semantically invalid persisted duration from aggregate reads", async () => {
        await withUsageDatabase("usage-invalid-aggregate-duration", async (database) => {
            const invalid = inferenceRecord("invalid-aggregate-duration", "agent-1", 20, {
                durationMs: 999,
            });
            await insertRawRecord(database, invalid);
            /*
             * Aggregate parsing must enforce the same semantic invariants as
             * readPage.  A shape-valid but inconsistent row must never become
             * a trusted total.
             */
            await expect(
                new UsageModule({}).aggregate(database.context, { agentId: "agent-1" }),
            ).rejects.toThrow("duration");
        });
    });

    it("retains exactly the newest bounded records and exposes precise page cursors", async () => {
        await withUsageDatabase("usage-retention-and-cursors", async (database) => {
            const store = new UsageDatabase();
            for (let index = 0; index <= MAX_USAGE_RECORDS; index++) {
                await store.record(
                    database.context,
                    inferenceRecord(`record-${index}`, "agent-1", index + 10),
                );
            }
            const module = new UsageModule({ maxPageSize: 7 });
            const first = await module.readPage(database.context, "agent-1", { limit: 7 });
            expect(first.records).toHaveLength(7);
            expect(first.records[0]?.id).toBe("record-1");
            expect(first.nextCursor).toBe(7);
            if (first.nextCursor === undefined) throw new Error("Expected a continuation cursor");
            const second = await module.readPage(database.context, "agent-1", {
                cursor: first.nextCursor,
                limit: 7,
            });
            expect(second.cursor).toBe(7);
            expect(second.records[0]?.id).toBe("record-8");
            expect(second.nextCursor).toBe(14);
            const final = await module.readPage(database.context, "agent-1", {
                cursor: 497,
                limit: 7,
            });
            expect(final.records).toHaveLength(3);
            expect(final.nextCursor).toBeUndefined();
            expect(final.totalRecords).toBe(MAX_USAGE_RECORDS);
        });
    });

    it("pages aggregate groups without skipping or repeating a group", async () => {
        await withUsageDatabase("usage-group-cursors", async (database) => {
            for (const [index, provider] of ["provider-a", "provider-b", "provider-c"].entries()) {
                await insertRawRecord(
                    database,
                    inferenceRecord(`group-${index}`, "agent-1", index + 11, {
                        provider,
                    }),
                );
            }
            const module = new UsageModule({ maxGroups: 1 });
            const pages: UsageSummary[] = [];
            let cursor = 0;
            while (true) {
                const page = await module.aggregate(database.context, {
                    agentId: "agent-1",
                    cursor,
                    maxGroups: 1,
                });
                pages.push(page);
                if (page.nextCursor === undefined) break;
                expect(page.nextCursor).toBe(cursor + page.groups.length);
                cursor = page.nextCursor;
            }
            expect(pages.map((page) => page.groups[0]?.provider)).toEqual([
                "provider-a",
                "provider-b",
                "provider-c",
            ]);
            expect(
                new Set(pages.flatMap((page) => page.groups.map((group) => group.provider))).size,
            ).toBe(3);
        });
    });

    it("rejects invalid page and aggregate bounds before touching storage", async () => {
        await withUsageDatabase("usage-query-bounds", async (database) => {
            const module = new UsageModule({ maxPageSize: 2, maxGroups: 2 });
            await expect(
                module.readPage(database.context, "agent-1", { limit: 3 }),
            ).rejects.toThrow("cannot exceed");
            await expect(
                module.readPage(database.context, "agent-1", { cursor: -1 }),
            ).rejects.toThrow("invalid");
            await expect(
                module.aggregate(database.context, { agentId: "agent-1", maxGroups: 3 }),
            ).rejects.toThrow("cannot exceed");
            await expect(
                module.aggregate(database.context, { agentId: "agent-1", cursor: -1 }),
            ).rejects.toThrow("invalid");
        });
    });

    it("enforces the current-agent boundary for reads, aggregate reads, and resets", async () => {
        await withUsageDatabase("usage-agent-boundary", async (database) => {
            await insertRawRecord(database, inferenceRecord("owned", "agent-1", 10));
            await insertRawRecord(database, inferenceRecord("other", "agent-2", 11));
            const module = new UsageModule({});
            const current = agentContext(database.context, "agent-1");

            await expect(module.read(current, "agent-2")).rejects.toThrow("current agent");
            await expect(module.aggregate(current, {})).rejects.toThrow();
            await expect(module.aggregate(current, { agentId: "agent-2" })).rejects.toThrow(
                "current agent",
            );
            await expect(module.reset(current, "agent-2")).rejects.toThrow("current agent");
            await expect(module.resetAll(current)).rejects.toThrow();
            await expect(module.read(current, "agent-1")).resolves.toMatchObject({
                agentId: "agent-1",
                totalTokens: 5,
            });
        });
    });

    it("keeps host-neutral usage tools targetable while agent tools remain self-scoped", async () => {
        await withUsageDatabase("usage-tool-scope", async (database) => {
            await insertRawRecord(database, inferenceRecord("a", "agent-1", 11));
            await insertRawRecord(database, inferenceRecord("b", "agent-2", 12));
            const module = new UsageModule({});
            const hostTool = getUsageTool(module);
            await expect(
                hostTool.execute(database.context, { target: "agent-2" }, undefined as never),
            ).resolves.toMatchObject({ agentId: "agent-2", totalTokens: 5 });
            await expect(
                hostTool.execute(database.context, { aggregate: true }, undefined as never),
            ).resolves.toMatchObject({ totalTokens: 10 });

            const agentTool = getUsageTool(module, "agent-1");
            await expect(
                agentTool.execute(
                    agentContext(database.context),
                    { target: "agent-2" },
                    undefined as never,
                ),
            ).rejects.toThrow("current agent");
            await expect(
                agentTool.execute(
                    agentContext(database.context),
                    { aggregate: true },
                    undefined as never,
                ),
            ).resolves.toMatchObject({ agentId: "agent-1", totalTokens: 5 });
            expect(agentTool.durable).toBe(true);
            expect(agentTool.shouldReviewInAutoMode?.({} as never, {} as never)).toBe(false);
        });
    });

    it("validates complete agent trees, including duplicate IDs, cycles, roots, totals, and limits", async () => {
        await withUsageDatabase("usage-tree-validation", async (database) => {
            const invalidTrees: UsageAgentTree[] = [
                {
                    sessions: [
                        {
                            agentId: "agent-1",
                            modelId: "model",
                            path: "/root",
                            providerId: "provider",
                            relation: "root",
                            status: "running",
                            totalTokens: 1,
                        },
                        {
                            agentId: "agent-1",
                            modelId: "model",
                            path: "/root/duplicate",
                            providerId: "provider",
                            relation: "subagent",
                            parentAgentId: "agent-1",
                            status: "running",
                            totalTokens: 1,
                        },
                    ],
                    totalTokens: 2,
                },
                {
                    sessions: [
                        {
                            agentId: "agent-1",
                            modelId: "model",
                            path: "/root",
                            providerId: "provider",
                            relation: "root",
                            status: "running",
                            totalTokens: 1,
                        },
                        {
                            agentId: "agent-2",
                            modelId: "model",
                            path: "/orphan",
                            providerId: "provider",
                            relation: "delegated",
                            parentAgentId: "missing",
                            status: "running",
                            totalTokens: 1,
                        },
                    ],
                    totalTokens: 2,
                },
                {
                    sessions: [
                        {
                            agentId: "agent-1",
                            modelId: "model",
                            path: "/root",
                            providerId: "provider",
                            relation: "root",
                            status: "running",
                            totalTokens: 1,
                        },
                        {
                            agentId: "agent-2",
                            modelId: "model",
                            path: "/root/a",
                            providerId: "provider",
                            relation: "subagent",
                            parentAgentId: "agent-3",
                            status: "running",
                            totalTokens: 1,
                        },
                        {
                            agentId: "agent-3",
                            modelId: "model",
                            path: "/root/b",
                            providerId: "provider",
                            relation: "delegated",
                            parentAgentId: "agent-2",
                            status: "running",
                            totalTokens: 1,
                        },
                    ],
                    totalTokens: 3,
                },
            ];
            for (const [index, invalid] of invalidTrees.entries()) {
                const module = new UsageModule({
                    agentTreeReader: () => invalid,
                });
                await expect(
                    module.readAgentTreeUsage(database.context, "agent-1"),
                ).rejects.toThrow();
                expect(index).toBeLessThan(invalidTrees.length);
            }

            const wrongTotal = tree();
            wrongTotal.totalTokens = 999;
            await expect(
                new UsageModule({ agentTreeReader: () => wrongTotal }).readAgentTreeUsage(
                    database.context,
                    "agent-1",
                ),
            ).rejects.toThrow("inconsistent");
        });
    });

    it("requires agent-tree authorization only for agent-scoped reads and validates async seams", async () => {
        await withUsageDatabase("usage-tree-authorization", async (database) => {
            const reader = async () => structuredClone(tree());
            const denied = new UsageModule({
                agentTreeReader: reader,
                agentTreeAuthorization: async () => false,
            });
            await expect(
                denied.readAgentTreeUsage(agentContext(database.context), "agent-1"),
            ).rejects.toThrow("not authorized");

            const hostModule = new UsageModule({ agentTreeReader: reader });
            await expect(
                hostModule.readAgentTreeUsage(database.context, "agent-1"),
            ).resolves.toEqual(tree());

            const malformedReader = new UsageModule({
                agentTreeReader: async () => ({ sessions: [], totalTokens: 0 }),
                agentTreeAuthorization: () => true,
            });
            await expect(
                malformedReader.readAgentTreeUsage(agentContext(database.context), "agent-1"),
            ).rejects.toThrow();
        });
    });

    it("renders bounded model output without emitting a partial group row", async () => {
        await withUsageDatabase("usage-output-bounds", async (database) => {
            const module = new UsageModule({ maxOutputCharacters: 256 });
            const summary: UsageSummary = {
                agentId: "agent-1",
                cursor: 0,
                totalGroups: 2,
                inferenceCount: 2,
                turnCount: 0,
                inputTokens: 2,
                outputTokens: 2,
                totalTokens: 4,
                inferenceDurationMs: 20,
                turnDurationMs: 0,
                totalDurationMs: 20,
                groups: [
                    {
                        provider: "p".repeat(256),
                        model: "m".repeat(256),
                        effort: "max",
                        tier: "priority",
                        inferenceCount: 1,
                        turnCount: 0,
                        inputTokens: 1,
                        outputTokens: 1,
                        totalTokens: 2,
                        inferenceDurationMs: 10,
                        turnDurationMs: 0,
                        totalDurationMs: 10,
                    },
                ],
                nextCursor: 1,
            };
            const output = module.formatForModel(summary, 256);
            expect(output.length).toBeLessThanOrEqual(256);
            expect(output).toContain("cursor=1");
            expect(output).not.toContain("p".repeat(256));
            expect(() => module.formatForModel(summary, MAX_USAGE_OUTPUT_CHARACTERS + 1)).toThrow(
                "bound",
            );
        });
    });

    it("publishes one stable deeply frozen event and keeps listener receivers intact", async () => {
        await withUsageDatabase("usage-events-stable", async (database) => {
            let now = 100;
            let transactional: UsageEvent | undefined;
            let postCommit: UsageEvent | undefined;
            let transactionalReceiver: unknown;
            let postCommitReceiver: unknown;
            const listener = {
                onEventTransactional(this: unknown, _ctx: Context, event: UsageEvent) {
                    transactionalReceiver = this;
                    transactional = event;
                    expect(Object.isFrozen(event)).toBe(true);
                    if (event.type !== "usage_recorded") {
                        throw new Error("Expected a recorded usage event");
                    }
                    const record = event.record;
                    if (record.kind !== "inference") {
                        throw new Error("Expected an inference usage event");
                    }
                    expect(Object.isFrozen(record)).toBe(true);
                    expect(() => {
                        record.tokens.input = 99;
                    }).toThrow();
                },
                onEvent(this: unknown, _ctx: Context, event: UsageEvent) {
                    postCommitReceiver = this;
                    postCommit = event;
                },
            };
            const module = new UsageModule({ clock: () => now, listener });
            const hooks = await resolveModuleHooks(database.context, module);
            const scope = makeScope(database.database);
            await hooks.beforeInferenceTransact!(database.context, scope, {
                loopId: "loop",
                turnId: "turn",
                inferenceId: "event-id",
                contextTokens: undefined,
            });
            now = 110;
            await runWithAfterCommit(database.context, async (txCtx) => {
                await hooks.afterInferenceTransact!(txCtx, scope, {
                    loopId: "loop",
                    turnId: "turn",
                    inferenceId: "event-id",
                    contextTokens: undefined,
                    state: "normal",
                    tokens: { input: 3, output: 2 },
                });
            });
            expect(transactionalReceiver).toBe(listener);
            expect(postCommitReceiver).toBe(listener);
            expect(postCommit).toBe(transactional);
            expect(postCommit).toEqual({
                type: "usage_recorded",
                eventId: "event-id",
                at: 110,
                record: expect.objectContaining({ id: "event-id" }),
            });
        });
    });

    it("contains post-commit listener errors and hostile observer failures", async () => {
        await withUsageDatabase("usage-post-commit-errors", async (database) => {
            const report = vi.fn(async () => undefined);
            const hostile = {
                get message(): never {
                    throw new Error("message trap");
                },
                [Symbol.toPrimitive](): never {
                    throw new Error("primitive trap");
                },
            };
            let now = 100;
            const module = new UsageModule({
                clock: () => now,
                listener: {
                    onEvent: async () => {
                        throw hostile;
                    },
                },
                onObserverError: report,
            });
            const hooks = await resolveModuleHooks(database.context, module);
            const scope = makeScope(database.database);
            await hooks.beforeInferenceTransact!(database.context, scope, {
                loopId: "loop",
                turnId: "turn",
                inferenceId: "post-error",
                contextTokens: undefined,
            });
            now = 110;
            await expect(
                runWithAfterCommit(database.context, async (txCtx) => {
                    await hooks.afterInferenceTransact!(txCtx, scope, {
                        loopId: "loop",
                        turnId: "turn",
                        inferenceId: "post-error",
                        contextTokens: undefined,
                        state: "normal",
                        tokens: { input: 1, output: 1 },
                    });
                }),
            ).resolves.toBeUndefined();
            expect(report).toHaveBeenCalledWith(
                expect.anything(),
                "post_commit_listener",
                expect.any(String),
            );
        });
    });

    it("does not publish reset events or delete rows when an outer transaction rolls back", async () => {
        await withUsageDatabase("usage-reset-rollback", async (database) => {
            await insertRawRecord(database, inferenceRecord("rollback", "agent-1", 10));
            const events: UsageEvent[] = [];
            const module = new UsageModule({
                idFactory: () => "reset-event",
                clock: () => 20,
                listener: {
                    onEvent: (_ctx, event) => {
                        events.push(event);
                    },
                },
            });
            await expect(
                database.context.inTx(async (outer) => {
                    await module.reset(outer, "agent-1");
                    throw new Error("abort outer transaction");
                }),
            ).rejects.toThrow("abort outer transaction");
            expect(events).toEqual([]);
            await expect(module.readPage(database.context, "agent-1")).resolves.toMatchObject({
                totalRecords: 1,
                records: [{ id: "rollback" }],
            });
        });
    });

    it("does not let a transactional listener failure escape advisory accounting", async () => {
        await withUsageDatabase("usage-transactional-listener-failure", async (database) => {
            let now = 100;
            const report = vi.fn(async () => undefined);
            const module = new UsageModule({
                clock: () => now,
                listener: {
                    onEventTransactional: () => {
                        throw new Error("transactional projection failed");
                    },
                },
                onObserverError: report,
            });
            const hooks = await resolveModuleHooks(database.context, module);
            const scope = makeScope(database.database);
            await hooks.beforeInferenceTransact!(database.context, scope, {
                loopId: "loop",
                turnId: "turn",
                inferenceId: "transactional-failure",
                contextTokens: undefined,
            });
            now = 110;
            await expect(
                database.context.inTx(async (txCtx) => {
                    await hooks.afterInferenceTransact!(txCtx, scope, {
                        loopId: "loop",
                        turnId: "turn",
                        inferenceId: "transactional-failure",
                        contextTokens: undefined,
                        state: "normal",
                        tokens: { input: 1, output: 1 },
                    });
                }),
            ).resolves.toBeUndefined();
            expect(report).toHaveBeenCalledWith(
                expect.anything(),
                "after_inference",
                expect.stringContaining("projection"),
            );
            /*
             * Accounting is advisory: the record remains durable even when
             * an optional transactional observer fails.
             */
            await expect(module.readPage(database.context, "agent-1")).resolves.toMatchObject({
                records: [{ id: "transactional-failure" }],
            });
        });
    });

    it("rejects invalid ID factories without changing reset state", async () => {
        await withUsageDatabase("usage-id-factory", async (database) => {
            await insertRawRecord(database, inferenceRecord("reset-target", "agent-1", 10));
            const module = new UsageModule({
                idFactory: () => "x".repeat(129),
            });
            await expect(module.reset(database.context, "agent-1")).rejects.toThrow(
                "invalid result",
            );
            await expect(module.readPage(database.context, "agent-1")).resolves.toMatchObject({
                totalRecords: 1,
            });
        });
    });

    it("rejects unknown options, invalid bounds, and invalid clock values", async () => {
        expect(() => new UsageModule({ unknown: true } as never)).toThrow("unknown");
        expect(() => new UsageModule({ maxPageSize: 0 })).toThrow("unknown");
        expect(() => new UsageModule({ maxGroups: MAX_USAGE_GROUPS + 1 })).toThrow("unknown");
        expect(() => new UsageModule({ maxOutputCharacters: 255 })).toThrow("unknown");

        await withUsageDatabase("usage-invalid-clock", async (database) => {
            const report = vi.fn(async () => undefined);
            const module = new UsageModule({ clock: () => -1, onObserverError: report });
            const hooks = await resolveModuleHooks(database.context, module);
            const scope = makeScope(database.database);
            await hooks.beforeTurnTransact!(database.context, scope, {
                loopId: "loop",
                turnId: "turn",
                contextTokens: undefined,
            });
            expect(report).toHaveBeenCalledWith(
                expect.anything(),
                "begin",
                expect.stringContaining("clock"),
            );
            expect((await module.readPage(database.context, "agent-1")).records).toEqual([]);
        });
    });

    it("rejects invalid tree paths and root identity mismatches", async () => {
        await withUsageDatabase("usage-tree-paths", async (database) => {
            const invalidPath = tree();
            invalidPath.sessions[0]!.path = "relative";
            await expect(
                new UsageModule({ agentTreeReader: () => invalidPath }).readAgentTreeUsage(
                    database.context,
                    "agent-1",
                ),
            ).rejects.toThrow("canonical path");

            await expect(
                new UsageModule({
                    agentTreeReader: () => tree("different-root"),
                }).readAgentTreeUsage(database.context, "agent-1"),
            ).rejects.toThrow("rooted at the wrong");
        });
    });

    it("keeps reset events bounded and reports the removed count", async () => {
        await withUsageDatabase("usage-reset-event-count", async (database) => {
            for (let index = 0; index < 3; index++) {
                await insertRawRecord(
                    database,
                    inferenceRecord(`reset-${index}`, "agent-1", index + 10),
                );
            }
            const events: UsageEvent[] = [];
            const module = new UsageModule({
                idFactory: () => "reset-event",
                clock: () => 100,
                listener: {
                    onEventTransactional: (_ctx, event) => {
                        events.push(event);
                    },
                },
            });
            await expect(module.reset(database.context, "agent-1")).resolves.toBe(3);
            expect(events).toEqual([
                {
                    type: "usage_reset",
                    eventId: "reset-event",
                    at: 100,
                    agentId: "agent-1",
                    removed: 3,
                },
            ]);
            await expect(module.reset(database.context, "agent-1")).resolves.toBe(0);
            expect(events).toHaveLength(1);
        });
    });

    it("returns exact collection aggregates and latest context measurements", async () => {
        await withUsageDatabase("usage-collection-aggregate", async (database) => {
            await insertRawRecord(database, inferenceRecord("one", "agent-1", 10));
            await insertRawRecord(
                database,
                turnRecord("turn-1", "agent-1", 20, { contextTokens: 50 }),
            );
            await insertRawRecord(
                database,
                inferenceRecord("two", "agent-2", 30, {
                    provider: "provider-other",
                    model: "model-other",
                    tokens: { input: 4, output: 6 },
                }),
            );
            const summary = await new UsageModule({}).aggregate(database.context, {});
            expect(summary).toMatchObject({
                totalTokens: 15,
                inferenceCount: 2,
                turnCount: 1,
                currentContext: {
                    contextTokens: 50,
                    provider: "provider-main",
                },
            });
            expect(summary.groups).toHaveLength(2);
            expect(summary.groups.map((group) => group.provider)).toEqual([
                "provider-main",
                "provider-other",
            ]);
        });
    });

    it("keeps model-facing tree output bounded at the minimum budget", async () => {
        await withUsageDatabase("usage-tree-output", async (database) => {
            const module = new UsageModule({ maxOutputCharacters: 256 });
            const large = tree();
            large.sessions.push(
                ...Array.from({ length: 20 }, (_, index) => ({
                    agentId: `agent-${index + 3}`,
                    modelId: "model",
                    parentAgentId: "agent-1",
                    path: `/root/${index}`,
                    providerId: "provider",
                    relation: "delegated" as const,
                    status: "completed",
                    totalTokens: index,
                })),
            );
            large.totalTokens = large.sessions.reduce(
                (total, session) => total + session.totalTokens,
                0,
            );
            const output = module.formatAgentTreeUsageForModel(large, 256);
            expect(output.length).toBeLessThanOrEqual(256);
            expect(output).toContain("Agent tree usage");
        });
    });

    it("validates aggregate shape and rejects forged totals/cursors from persisted storage", async () => {
        await withUsageDatabase("usage-summary-invariants", async (database) => {
            await insertRawRecord(database, inferenceRecord("summary", "agent-1", 10));
            const module = new UsageModule({});
            const summary = await module.aggregate(database.context, {
                agentId: "agent-1",
            });
            expect(summary.totalTokens).toBe(summary.inputTokens + summary.outputTokens);
            expect(summary.totalDurationMs).toBe(
                summary.inferenceDurationMs + summary.turnDurationMs,
            );
            await expect(
                module.aggregate(database.context, {
                    agentId: "agent-1",
                    cursor: MAX_USAGE_GROUPS,
                }),
            ).rejects.toThrow("wrong scope or page");
        });
    });

    it("keeps agent-tree tool output and contract bounded", async () => {
        await withUsageDatabase("usage-tree-tool-contract", async (database) => {
            const module = new UsageModule({
                agentTreeReader: () => tree(),
                agentTreeAuthorization: () => true,
            });
            const tool = getAgentTreeUsageTool(module, "agent-1");
            expect(tool.name).toBe("get_agent_tree_usage");
            expect(tool.durable).toBe(true);
            expect(tool.shouldReviewInAutoMode?.({} as never, {} as never)).toBe(false);
            const result = await tool.execute(
                agentContext(database.context),
                {},
                undefined as never,
            );
            expect(result).toEqual(tree());
            const rendered = tool
                .toLLM(result)
                .map((block) => (block.type === "text" ? block.text : ""))
                .join("");
            expect(rendered.length).toBeLessThanOrEqual(MAX_USAGE_OUTPUT_CHARACTERS);
            expect(rendered).toContain("agent-2");
        });
    });
});
