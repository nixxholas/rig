import type {
    AgentMessageMetadata,
    AgentModuleScope,
    AgentSystemRef,
} from "@slopus/happy-agent-base";
import { agentDatabaseRun, withAgentContext } from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { DutyModule } from "../../sources/duty/DutyModule.js";
import type { IssueDutyInput } from "../../sources/duty/Duty.js";
import { moduleDatabase } from "../support/moduleDatabase.js";
import { resolveModuleHooks } from "../support/moduleHooks.js";

const issued: IssueDutyInput = {
    allowedTools: ["read_file", "edit_file"],
    charter: "Maintain the release branch.",
    dutyId: "duty-release",
    permissionCeiling: "workspace_write",
    tenureId: "tenure-one",
    trigger: "Inspect the latest build failure.",
};

interface Wake {
    readonly agentId: string;
    readonly id?: string;
    readonly metadata?: AgentMessageMetadata;
    readonly permissionMode?: string;
    readonly text: string;
}

function recordingAgents(failSend = false): {
    readonly aborts: string[];
    readonly ref: AgentSystemRef;
    readonly wakes: Wake[];
} {
    const aborts: string[] = [];
    const wakes: Wake[] = [];
    const ref = {
        abort: async (_ctx: Context, agentId: string) => {
            aborts.push(agentId);
        },
        send: async (
            _ctx: Context,
            agentId: string,
            message: { readonly content: readonly { readonly text?: string }[] },
            options?: {
                readonly id?: string;
                readonly metadata?: AgentMessageMetadata;
                readonly permissionMode?: string;
            },
        ) => {
            if (failSend) throw new Error("send failed");
            wakes.push({
                agentId,
                ...(options?.id === undefined ? {} : { id: options.id }),
                ...(options?.metadata === undefined ? {} : { metadata: options.metadata }),
                ...(options?.permissionMode === undefined
                    ? {}
                    : { permissionMode: options.permissionMode }),
                text: message.content.map((block) => block.text ?? "").join(""),
            });
        },
    } as unknown as AgentSystemRef;
    return { aborts, ref, wakes };
}

function memoryKV() {
    const values = new Map<string, unknown>();
    return {
        values,
        read: async (_ctx: Context, key: string) => values.get(key),
        write: async (_ctx: Context, key: string, value: unknown) => {
            values.set(key, structuredClone(value));
        },
    };
}

function scope(agentId: string, permissionMode = "workspace_write") {
    return {
        agent: { id: agentId, permissionMode },
        runKV: memoryKV(),
    } as unknown as AgentModuleScope;
}

describe("DutyModule", () => {
    it("issues a durable binding and wakes the bound agent with constrained provenance", async () => {
        const module = new DutyModule();
        const database = moduleDatabase(module.migrations, "duty-issue-test");
        const agents = recordingAgents();
        await database.ready;
        module.beforeStart(database.context, agents.ref);
        try {
            const result = await module.issueDuty(database.context, "agent-a", issued);

            expect(result.duty).toMatchObject({
                agentId: "agent-a",
                allowedTools: issued.allowedTools,
                charter: issued.charter,
                dutyId: issued.dutyId,
                permissionCeiling: issued.permissionCeiling,
                status: "active",
                tenureId: issued.tenureId,
            });
            expect(result.run.status).toBe("queued");
            expect(agents.wakes).toHaveLength(1);
            expect(agents.wakes[0]).toMatchObject({
                agentId: "agent-a",
                id: expect.stringMatching(/^d[a-f0-9]{31}$/),
                metadata: {
                    dutyRunId: result.run.runId,
                    messageOrigin: "agent",
                    senderAgentId: "agent-a",
                },
                permissionMode: "workspace_write",
                text: expect.stringContaining(issued.charter),
            });

            const reloaded = new DutyModule();
            await expect(reloaded.duty(database.context, "agent-a")).resolves.toEqual(result.duty);
            await expect(reloaded.runs(database.context, "agent-a")).resolves.toEqual([result.run]);
        } finally {
            database.close();
        }
    });

    it("makes identical issuance retries converge and rolls back a rejected wake", async () => {
        const module = new DutyModule();
        const database = moduleDatabase(module.migrations, "duty-idempotency-test");
        const agents = recordingAgents();
        await database.ready;
        module.beforeStart(database.context, agents.ref);
        try {
            const first = await module.issueDuty(database.context, "agent-a", issued);
            const retry = await module.issueDuty(database.context, "agent-a", issued);
            expect(retry).toEqual(first);
            expect(agents.wakes).toHaveLength(1);

            await expect(
                module.issueDuty(database.context, "agent-a", {
                    ...issued,
                    dutyId: "different-duty",
                }),
            ).rejects.toThrow("unfinished Duty");
        } finally {
            database.close();
        }

        const failed = new DutyModule();
        const failedDatabase = moduleDatabase(failed.migrations, "duty-wake-rollback-test");
        await failedDatabase.ready;
        failed.beforeStart(failedDatabase.context, recordingAgents(true).ref);
        try {
            await expect(
                failed.issueDuty(failedDatabase.context, "agent-b", issued),
            ).rejects.toThrow("send failed");
            await expect(failed.duty(failedDatabase.context, "agent-b")).resolves.toBeUndefined();
            await expect(failed.runs(failedDatabase.context, "agent-b")).resolves.toEqual([]);
        } finally {
            failedDatabase.close();
        }
    });

    it("correlates an accepted wake with its run and settles it atomically", async () => {
        const module = new DutyModule();
        const database = moduleDatabase(module.migrations, "duty-settlement-test");
        const agents = recordingAgents();
        await database.ready;
        const hooks = await resolveModuleHooks(database.context, module, agents.ref);
        const runScope = scope("agent-a");
        try {
            const issuedDuty = await module.issueDuty(database.context, "agent-a", issued);
            await database.context.inTx(async (ctx) => {
                await hooks.messageAcceptedTransact!(ctx, runScope, {
                    id: "message-one",
                    kind: "send",
                    message: { role: "user", content: [] },
                    metadata: agents.wakes[0]!.metadata!,
                });
            });
            await expect(module.currentRun(database.context, "agent-a")).resolves.toMatchObject({
                runId: issuedDuty.run.runId,
                status: "running",
            });

            await database.context.inTx(async (ctx) => {
                await hooks.afterAgentSettledTransact!(ctx, runScope, {
                    loopId: "loop-one",
                    settlementId: "settlement-one",
                });
            });
            await expect(module.runs(database.context, "agent-a")).resolves.toEqual([
                expect.objectContaining({
                    runId: issuedDuty.run.runId,
                    settledAt: expect.any(Number),
                    status: "completed",
                }),
            ]);
        } finally {
            database.close();
        }
    });

    it("records a failed settlement without leaving the Duty run active", async () => {
        const module = new DutyModule();
        const database = moduleDatabase(module.migrations, "duty-failed-settlement-test");
        const agents = recordingAgents();
        await database.ready;
        const hooks = await resolveModuleHooks(database.context, module, agents.ref);
        const runScope = scope("agent-a");
        try {
            await module.issueDuty(database.context, "agent-a", issued);
            await database.context.inTx(async (ctx) => {
                await hooks.messageAcceptedTransact!(ctx, runScope, {
                    id: "message-one",
                    kind: "send",
                    message: { role: "user", content: [] },
                    metadata: agents.wakes[0]!.metadata!,
                });
                await hooks.afterAgentSettledTransact!(ctx, runScope, {
                    error: "provider failed",
                    loopId: "loop-one",
                    settlementId: "settlement-one",
                });
            });

            await expect(module.currentRun(database.context, "agent-a")).resolves.toBeUndefined();
            await expect(module.runs(database.context, "agent-a")).resolves.toEqual([
                expect.objectContaining({ error: "provider failed", status: "failed" }),
            ]);
        } finally {
            database.close();
        }
    });

    it("exposes inspection while enforcing status, tool, and permission ceilings", async () => {
        const module = new DutyModule();
        const database = moduleDatabase(module.migrations, "duty-enforcement-test");
        const agents = recordingAgents();
        await database.ready;
        const hooks = await resolveModuleHooks(database.context, module, agents.ref);
        try {
            await module.issueDuty(database.context, "agent-a", issued);
            const agentScope = scope("agent-a", "full_access");
            const tools = await hooks.tools!(database.context, agentScope);
            expect(tools.map((tool) => tool.name)).toEqual(["get_duty"]);
            const getDuty = tools[0]!;
            const read = await getDuty.execute(
                withAgentContext(database.context, {
                    id: "agent-a",
                    permissionMode: "workspace_write",
                    provider: "scripted",
                }),
                {},
                {} as never,
            );
            expect(read.duty).toMatchObject({ dutyId: issued.dutyId });

            const clamp = await hooks.beforeToolCall!(database.context, agentScope, {
                arguments: {},
                callId: "call-one",
                tool: { name: "read_file" } as never,
            });
            expect(clamp).toEqual({ type: "run", permissionMode: "workspace_write" });

            const refusal = await hooks.beforeToolCall!(database.context, agentScope, {
                arguments: {},
                callId: "call-two",
                tool: { name: "shell" } as never,
            });
            expect(refusal).toMatchObject({ type: "answer", isError: true });

            await module.changeDutyStatus(database.context, "agent-a", "paused");
            await expect(module.runs(database.context, "agent-a")).resolves.toEqual([
                expect.objectContaining({
                    error: "Duty paused by its issuer.",
                    status: "failed",
                }),
            ]);
            const paused = await hooks.beforeToolCall!(database.context, agentScope, {
                arguments: {},
                callId: "call-three",
                tool: { name: "read_file" } as never,
            });
            expect(paused).toMatchObject({ type: "answer", isError: true });
            expect(agents.aborts).toEqual(["agent-a"]);

            await module.changeDutyStatus(database.context, "agent-a", "active");
            expect(agents.wakes).toHaveLength(2);
            await expect(module.currentRun(database.context, "agent-a")).resolves.toMatchObject({
                status: "queued",
                trigger: "Duty resumed by its issuer.",
            });

            const autoScope = scope("agent-a", "auto");
            const autoClamp = await hooks.beforeToolCall!(database.context, autoScope, {
                arguments: {},
                callId: "call-four",
                tool: { name: "read_file" } as never,
            });
            expect(autoClamp).toEqual({ type: "run", permissionMode: "workspace_write" });
        } finally {
            database.close();
        }
    });

    it("serializes competing issuance and permits a new tenure only after stop", async () => {
        const module = new DutyModule();
        const database = moduleDatabase(module.migrations, "duty-concurrency-test");
        const agents = recordingAgents();
        await database.ready;
        module.beforeStart(database.context, agents.ref);
        try {
            const results = await Promise.all([
                module.issueDuty(database.context, "agent-a", issued),
                module.issueDuty(database.context, "agent-a", issued),
            ]);
            expect(results[0]).toEqual(results[1]);
            expect(agents.wakes).toHaveLength(1);

            await module.changeDutyStatus(database.context, "agent-a", "stopped");
            await expect(
                module.changeDutyStatus(database.context, "agent-a", "active"),
            ).rejects.toThrow("stopped Duty cannot be resumed");

            const replacement = await module.issueDuty(database.context, "agent-a", {
                ...issued,
                dutyId: "duty-replacement",
                tenureId: "tenure-two",
            });
            expect(replacement.duty).toMatchObject({
                dutyId: "duty-replacement",
                status: "active",
                tenureId: "tenure-two",
            });
            expect(agents.wakes).toHaveLength(2);
        } finally {
            database.close();
        }
    });

    it("rejects malformed issuance and corrupt persisted authority", async () => {
        const module = new DutyModule();
        const database = moduleDatabase(module.migrations, "duty-validation-test");
        await database.ready;
        module.beforeStart(database.context, recordingAgents().ref);
        try {
            await expect(
                module.issueDuty(database.context, "agent-a", {
                    ...issued,
                    allowedTools: ["bad tool"],
                }),
            ).rejects.toThrow("issuance is invalid");
            await expect(
                module.issueDuty(database.context, "agent-a", {
                    ...issued,
                    charter: "   ",
                }),
            ).rejects.toThrow("binding is invalid");
            await expect(
                module.issueDuty(database.context, "agent-a", {
                    ...issued,
                    trigger: "   ",
                }),
            ).rejects.toThrow("trigger must not be empty");
            await expect(module.duty(database.context, "")).rejects.toThrow("agent ID is invalid");

            await agentDatabaseRun(
                database.database,
                sql`INSERT INTO happy_agent_duty_state (agent_id, value_json)
                    VALUES (${"agent-corrupt"}, ${JSON.stringify({ status: "unbounded" })})`,
            );
            await expect(module.duty(database.context, "agent-corrupt")).rejects.toThrow(
                "Stored Duty binding is invalid",
            );
        } finally {
            database.close();
        }
    });
});
