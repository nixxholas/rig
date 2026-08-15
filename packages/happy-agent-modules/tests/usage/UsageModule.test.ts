import { agentDatabaseRows, type AgentStorageTransaction } from "@slopus/happy-agent-base";
import { createRootContext, withAfterCommit, type Context } from "@steve.kite/stdlib";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { UsageModule } from "../../sources/usage/UsageModule.js";
import type { UsageEvent } from "../../sources/usage/UsageEvent.js";
import { moduleDatabase } from "../support/moduleDatabase.js";

const ctx = createRootContext().named("usage-module-test");

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

async function inCompletion(work: (txCtx: Context) => Promise<void>): Promise<void> {
    const [txCtx, drain] = withAfterCommit(ctx);
    await work(txCtx);
    await drain();
}

describe("UsageModule", () => {
    it("uses Base inference and turn IDs inside the ambient completion transaction", async () => {
        const database = moduleDatabase([], "usage-base-identities");
        let transactionCalls = 0;
        const transaction: AgentStorageTransaction = async (transactionCtx, work) => {
            transactionCalls++;
            const [txCtx, drain] = withAfterCommit(transactionCtx);
            const result = await work(txCtx, database.database);
            await drain();
            return result;
        };
        let now = 100;
        const events: UsageEvent[] = [];
        const module = new UsageModule({
            transaction,
            clock: () => now,
            listener: {
                onEventTransactional: (_eventCtx, event) => {
                    events.push(structuredClone(event));
                },
            },
        });
        await module.migrations[0]![1](database.context, database.database);
        await module.migrations[1]![1](database.context, database.database);
        const runKV = new FakeKV();
        const agentScope = scope(database.database, runKV);

        await module.beforeTurnTransact!(ctx, agentScope, {
            loopId: "loop-1",
            turnId: "turn-base-id",
            contextTokens: undefined,
        });
        now = 125;
        await module.beforeInferenceTransact!(ctx, agentScope, {
            loopId: "loop-1",
            turnId: "turn-base-id",
            inferenceId: "inference-base-id",
            contextTokens: undefined,
        });
        now = 150;
        await inCompletion(async (txCtx) => {
            await module.afterInferenceTransact!(txCtx, agentScope, {
                loopId: "loop-1",
                turnId: "turn-base-id",
                inferenceId: "inference-base-id",
                contextTokens: undefined,
                state: "normal",
                tokens: { input: 10, output: 4 },
            });
        });
        now = 175;
        await inCompletion(async (txCtx) => {
            await module.afterTurnTransact!(txCtx, agentScope, {
                loopId: "loop-1",
                turnId: "turn-base-id",
                contextTokens: 14,
                aborted: false,
            });
        });

        expect(transactionCalls).toBe(0);
        const page = await module.readPage(ctx, "agent-1");
        expect(transactionCalls).toBe(1);
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
        expect(events.map((event) => event.eventId)).toEqual([
            "inference-base-id",
            "turn-base-id",
        ]);
        expect(runKV.values.size).toBe(0);
        database.close();
    });

    it("drops reset receipts and performs each reset as an ordinary mutation", async () => {
        const database = moduleDatabase([], "usage-reset");
        const transaction: AgentStorageTransaction = async (transactionCtx, work) => {
            const [txCtx, drain] = withAfterCommit(transactionCtx);
            const result = await work(txCtx, database.database);
            await drain();
            return result;
        };
        let nextEventId = 0;
        const module = new UsageModule({
            transaction,
            clock: () => 100,
            idFactory: () => `reset-event-${nextEventId++}`,
        });
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
        await module.beforeInferenceTransact!(ctx, agentScope, {
            loopId: "loop-1",
            turnId: "turn-1",
            inferenceId: "inference-1",
            contextTokens: undefined,
        });
        await inCompletion(async (txCtx) => {
            await module.afterInferenceTransact!(txCtx, agentScope, {
                loopId: "loop-1",
                turnId: "turn-1",
                inferenceId: "inference-1",
                contextTokens: undefined,
                state: "normal",
                tokens: { input: 1, output: 1 },
            });
        });
        expect(await module.reset(ctx, "agent-1")).toBe(1);

        await module.beforeInferenceTransact!(ctx, agentScope, {
            loopId: "loop-2",
            turnId: "turn-2",
            inferenceId: "inference-2",
            contextTokens: undefined,
        });
        await inCompletion(async (txCtx) => {
            await module.afterInferenceTransact!(txCtx, agentScope, {
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