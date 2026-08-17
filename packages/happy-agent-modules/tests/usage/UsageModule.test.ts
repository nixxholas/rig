import { agentDatabaseRows, withAgentContext } from "@slopus/happy-agent-base";
import { withAfterCommit, type Context } from "@steve.kite/stdlib";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import type { UsageAgentTree } from "../../sources/usage/Usage.js";
import { UsageModule } from "../../sources/usage/UsageModule.js";
import type { UsageEvent } from "../../sources/usage/UsageEvent.js";
import { getAgentTreeUsageTool } from "../../sources/usage/tools/get_agent_tree_usage.js";
import { getUsageTool } from "../../sources/usage/tools/get_usage.js";
import { moduleDatabase } from "../support/moduleDatabase.js";
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

function scope(database: ReturnType<typeof moduleDatabase>["database"], runKV: FakeKV) {
    return {
        database,
        agent: {
            id: "agent-1",
            provider: "provider-main",
            providerKind: "codex" as const,
            model: "model-main",
            effort: "high" as const,
            tier: "priority" as const,
            permissionMode: "auto" as const,
        },
        kv: new FakeKV(),
        sharedKV: new FakeKV(),
        runKV,
    } as never;
}

async function inCompletion(ctx: Context, work: (txCtx: Context) => Promise<void>): Promise<void> {
    const [txCtx, drain] = withAfterCommit(ctx);
    await work(txCtx);
    await drain();
}

describe("UsageModule", () => {
    it("uses Base inference and turn IDs inside the ambient completion transaction", async () => {
        const database = moduleDatabase([], "usage-base-identities");
        const ctx = database.context;
        let now = 100;
        const events: UsageEvent[] = [];
        const module = new UsageModule({
            clock: () => now,
            listener: {
                onEventTransactional: (_eventCtx, event) => {
                    events.push(structuredClone(event));
                },
            },
        });
        const hooks = await resolveModuleHooks(ctx, module);
        await module.migrations[0]![1](database.context, database.database);
        await module.migrations[1]![1](database.context, database.database);
        const runKV = new FakeKV();
        const agentScope = scope(database.database, runKV);

        await hooks.beforeTurnTransact!(ctx, agentScope, {
            loopId: "loop-1",
            turnId: "turn-base-id",
            contextTokens: undefined,
        });
        now = 125;
        await hooks.beforeInferenceTransact!(ctx, agentScope, {
            loopId: "loop-1",
            turnId: "turn-base-id",
            inferenceId: "inference-base-id",
            contextTokens: undefined,
        });
        now = 150;
        await inCompletion(ctx, async (txCtx) => {
            await hooks.afterInferenceTransact!(txCtx, agentScope, {
                loopId: "loop-1",
                turnId: "turn-base-id",
                inferenceId: "inference-base-id",
                contextTokens: undefined,
                state: "normal",
                tokens: { input: 10, output: 4 },
            });
        });
        now = 175;
        await inCompletion(ctx, async (txCtx) => {
            await hooks.afterTurnTransact!(txCtx, agentScope, {
                loopId: "loop-1",
                turnId: "turn-base-id",
                contextTokens: 14,
                aborted: false,
            });
        });

        const page = await module.readPage(ctx, "agent-1");
        expect(page.records).toMatchObject([
            {
                id: "inference-base-id",
                kind: "inference",
                startedAt: 125,
                finishedAt: 150,
                durationMs: 25,
                tokens: { input: 10, output: 4 },
            },
            {
                id: "turn-base-id",
                kind: "turn",
                startedAt: 100,
                finishedAt: 175,
                durationMs: 75,
                contextTokens: 14,
            },
        ]);
        expect(events.map((event) => event.eventId)).toEqual(["inference-base-id", "turn-base-id"]);
        expect(runKV.values.size).toBe(0);
        await expect(module.read(ctx, "agent-1")).resolves.toMatchObject({
            currentContext: {
                approximate: false,
                contextTokens: 14,
                provider: "provider-main",
                model: "model-main",
            },
        });
        database.close();
    });

    it("clears the current context after a turn with no provider measurement", async () => {
        const database = moduleDatabase([], "usage-current-context-invalidation");
        const ctx = database.context;
        let now = 100;
        const module = new UsageModule({
            clock: () => now,
        });
        const hooks = await resolveModuleHooks(ctx, module);
        await module.migrations[0]![1](database.context, database.database);
        await module.migrations[1]![1](database.context, database.database);
        const runKV = new FakeKV();
        const agentScope = scope(database.database, runKV);

        await hooks.beforeTurnTransact!(ctx, agentScope, {
            loopId: "loop-1",
            turnId: "turn-1",
            contextTokens: undefined,
        });
        now = 120;
        await inCompletion(ctx, async (txCtx) => {
            await hooks.afterTurnTransact!(txCtx, agentScope, {
                loopId: "loop-1",
                turnId: "turn-1",
                contextTokens: 12,
                aborted: false,
            });
        });
        await expect(module.read(ctx, "agent-1")).resolves.toMatchObject({
            currentContext: { contextTokens: 12 },
        });

        now = 140;
        await hooks.beforeTurnTransact!(ctx, agentScope, {
            loopId: "loop-2",
            turnId: "turn-2",
            contextTokens: undefined,
        });
        now = 160;
        await inCompletion(ctx, async (txCtx) => {
            await hooks.afterTurnTransact!(txCtx, agentScope, {
                loopId: "loop-2",
                turnId: "turn-2",
                contextTokens: undefined,
                aborted: false,
            });
        });
        const summary = await module.read(ctx, "agent-1");
        expect(summary).not.toHaveProperty("currentContext");
        database.close();
    });

    it("allows the exported usage tool to aggregate for a host-neutral caller", async () => {
        const database = moduleDatabase([], "usage-host-neutral-tool");
        const ctx = database.context;
        let now = 100;
        const module = new UsageModule({
            clock: () => now,
        });
        const hooks = await resolveModuleHooks(ctx, module);
        await module.migrations[0]![1](database.context, database.database);
        await module.migrations[1]![1](database.context, database.database);
        const runKV = new FakeKV();
        const agentScope = scope(database.database, runKV);

        await hooks.beforeInferenceTransact!(ctx, agentScope, {
            loopId: "loop-1",
            turnId: "turn-1",
            inferenceId: "inference-1",
            contextTokens: undefined,
        });
        now = 110;
        await inCompletion(ctx, async (txCtx) => {
            await hooks.afterInferenceTransact!(txCtx, agentScope, {
                loopId: "loop-1",
                turnId: "turn-1",
                inferenceId: "inference-1",
                contextTokens: undefined,
                state: "normal",
                tokens: { input: 3, output: 2 },
            });
        });

        const tool = getUsageTool(module, "agent-1");
        const result = await tool.execute(ctx, { aggregate: true }, {} as never);
        expect(result.agentId).toBeUndefined();
        expect(result.totalTokens).toBe(5);
        database.close();
    });

    it("requires authorization before exposing an injected agent tree", async () => {
        const database = moduleDatabase([], "usage-agent-tree");
        const ctx = database.context;
        const agentCtx = withAgentContext(ctx, {
            id: "agent-1",
            provider: "provider-main",
            model: "model-main",
            effort: "high",
            serviceTier: "priority",
            permissionMode: "auto",
        });
        const tree: UsageAgentTree = {
            sessions: [
                {
                    agentId: "agent-1",
                    modelId: "model-main",
                    path: "/root",
                    providerId: "provider-main",
                    relation: "root",
                    status: "running",
                    totalTokens: 10,
                },
                {
                    agentId: "agent-2",
                    modelId: "model-subagent",
                    parentAgentId: "agent-1",
                    path: "/root/audit",
                    providerId: "provider-main",
                    relation: "subagent",
                    status: "completed",
                    totalTokens: 7,
                },
            ],
            totalTokens: 17,
        };
        const reader = () => structuredClone(tree);
        const denied = new UsageModule({ agentTreeReader: reader });
        await expect(denied.readAgentTreeUsage(agentCtx, "agent-1")).rejects.toThrow(
            "not authorized",
        );

        const module = new UsageModule({
            agentTreeReader: reader,
            agentTreeAuthorization: () => true,
        });
        await expect(module.readAgentTreeUsage(agentCtx, "agent-1")).resolves.toEqual(tree);
        const tool = getAgentTreeUsageTool(module, "agent-1");
        await expect(tool.execute(agentCtx, {}, {} as never)).resolves.toEqual(tree);
        await expect(module.readAgentTreeUsage(agentCtx, "agent-2")).rejects.toThrow(
            "current agent",
        );
        database.close();
    });

    it("drops reset receipts and performs each reset as an ordinary mutation", async () => {
        const database = moduleDatabase([], "usage-reset");
        const ctx = database.context;
        let nextEventId = 0;
        const module = new UsageModule({
            clock: () => 100,
            idFactory: () => `reset-event-${nextEventId++}`,
        });
        const hooks = await resolveModuleHooks(ctx, module);
        await module.migrations[0]![1](database.context, database.database);
        const beforeDrop = await agentDatabaseRows<{ name: string }>(
            database.database,
            sql`SELECT name FROM sqlite_master
                WHERE type = 'table' AND name = 'happy_agent_usage_reset_receipts'`,
        );
        expect(beforeDrop).toHaveLength(1);

        await module.migrations[1]![1](database.context, database.database);
        const afterDrop = await agentDatabaseRows<{ name: string }>(
            database.database,
            sql`SELECT name FROM sqlite_master
                WHERE type = 'table' AND name = 'happy_agent_usage_reset_receipts'`,
        );
        expect(afterDrop).toHaveLength(0);

        const runKV = new FakeKV();
        const agentScope = scope(database.database, runKV);
        await hooks.beforeInferenceTransact!(ctx, agentScope, {
            loopId: "loop-1",
            turnId: "turn-1",
            inferenceId: "inference-1",
            contextTokens: undefined,
        });
        await inCompletion(ctx, async (txCtx) => {
            await hooks.afterInferenceTransact!(txCtx, agentScope, {
                loopId: "loop-1",
                turnId: "turn-1",
                inferenceId: "inference-1",
                contextTokens: undefined,
                state: "normal",
                tokens: { input: 1, output: 1 },
            });
        });
        expect(await module.reset(ctx, "agent-1")).toBe(1);

        await hooks.beforeInferenceTransact!(ctx, agentScope, {
            loopId: "loop-2",
            turnId: "turn-2",
            inferenceId: "inference-2",
            contextTokens: undefined,
        });
        await inCompletion(ctx, async (txCtx) => {
            await hooks.afterInferenceTransact!(txCtx, agentScope, {
                loopId: "loop-2",
                turnId: "turn-2",
                inferenceId: "inference-2",
                contextTokens: undefined,
                state: "normal",
                tokens: { input: 2, output: 1 },
            });
        });
        expect(await module.reset(ctx, "agent-1")).toBe(1);
        expect(nextEventId).toBe(2);
        expect((await module.readPage(ctx, "agent-1")).records).toHaveLength(0);
        database.close();
    });
});
