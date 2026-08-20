import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";

import {
    agentDatabaseRun,
    type AgentBaseAcceptedMessage,
    type AgentBaseSettlement,
    type AgentBaseToolCall,
    type AgentBaseToolCallDecision,
    type AgentModule,
    type AgentModuleHooks,
    type AgentModuleScope,
    type AgentPermissionMode,
    type AgentSystemRef,
} from "@slopus/happy-agent-base";
import { Value } from "@sinclair/typebox/value";
import { afterCommit, type Context } from "@steve.kite/stdlib";

import { AGENT_MESSAGE_ORIGIN_METADATA, senderAgentIdMetadata } from "../impl/messageOrigin.js";
import {
    dutyAgentIdSchema,
    dutyBindingSchema,
    dutyIdSchema,
    dutyRunSchema,
    dutyStatusSchema,
    issueDutyInputSchema,
    type DutyBinding,
    type DutyRun,
    type DutyStatus,
    type IssueDutyInput,
} from "./Duty.js";
import { DutyDatabase } from "./impl/DutyDatabase.js";
import { formatDutyForModel } from "./impl/formatDutyForModel.js";
import { getDutyTool } from "./tools/get_duty.js";

const DUTY_RUN_METADATA_KEY = "dutyRunId";
const DUTY_RUN_KV_KEY = "currentRunId";
const DUTY_CONTROL_TOOLS = new Set(["get_duty"]);

export class DutyModule implements AgentModule {
    readonly name = "duty";
    readonly migrations = [
        [
            "001-duty-state",
            async (ctx: Context): Promise<void> => {
                await agentDatabaseRun(
                    ctx.db,
                    sql`CREATE TABLE IF NOT EXISTS happy_agent_duty_state (
                        agent_id TEXT PRIMARY KEY NOT NULL,
                        value_json TEXT NOT NULL
                    )`,
                );
                await agentDatabaseRun(
                    ctx.db,
                    sql`CREATE TABLE IF NOT EXISTS happy_agent_duty_runs (
                        run_id TEXT PRIMARY KEY NOT NULL,
                        agent_id TEXT NOT NULL,
                        created_at INTEGER NOT NULL,
                        value_json TEXT NOT NULL
                    )`,
                );
                await agentDatabaseRun(
                    ctx.db,
                    sql`CREATE INDEX IF NOT EXISTS happy_agent_duty_runs_agent
                        ON happy_agent_duty_runs (agent_id)`,
                );
            },
        ],
    ] as const;

    readonly #database = new DutyDatabase();
    readonly #mutations = new Map<string, Promise<void>>();
    #agents: AgentSystemRef | undefined;

    readonly beforeStart = (_ctx: Context, agents: AgentSystemRef): AgentModuleHooks => {
        this.#agents = agents;
        return {
            agentArchivedTransact: async (ctx, _scope, agent) => {
                const binding = await this.duty(ctx, agent.id);
                if (binding?.status === "active") await this.#changeStatus(ctx, agent.id, "paused");
            },
            tools: (_ctx, scope) => [getDutyTool(this, scope.agent.id)],
            instructions: async (ctx, scope) => {
                const binding = await this.duty(ctx, scope.agent.id);
                if (binding === undefined || binding.status === "stopped") return "";
                const run = await this.currentRun(ctx, scope.agent.id);
                return `This session is bound to a machine-issued Duty. The Duty is authority-limited; do not broaden its charter, tools, or permissions.\n${formatDutyForModel(binding, run)}`;
            },
            messageAcceptedTransact: async (ctx, scope, accepted) => {
                await this.#observeAcceptedRun(ctx, scope, accepted);
            },
            beforeToolCall: async (ctx, scope, call) =>
                await this.#enforceToolCall(ctx, scope, call),
            afterAgentSettledTransact: async (ctx, scope, settlement) => {
                await this.#settleObservedRun(ctx, scope, settlement);
            },
        };
    };

    async duty(ctx: Context, agentId: string): Promise<DutyBinding | undefined> {
        this.#assertAgentId(agentId);
        const value = await this.#database.binding(ctx, agentId);
        if (value === undefined) return undefined;
        if (!Value.Check(dutyBindingSchema, value))
            throw new Error("Stored Duty binding is invalid.");
        return structuredClone(value);
    }

    async runs(ctx: Context, agentId: string): Promise<readonly DutyRun[]> {
        this.#assertAgentId(agentId);
        const values = await this.#database.runs(ctx, agentId);
        return values.map((value) => {
            if (!Value.Check(dutyRunSchema, value)) throw new Error("Stored Duty run is invalid.");
            return structuredClone(value);
        });
    }

    async currentRun(ctx: Context, agentId: string): Promise<DutyRun | undefined> {
        const duty = await this.duty(ctx, agentId);
        if (duty === undefined) return undefined;
        const runs = await this.runs(ctx, agentId);
        return [...runs]
            .reverse()
            .find(
                (run) =>
                    run.dutyId === duty.dutyId &&
                    run.tenureId === duty.tenureId &&
                    (run.status === "queued" || run.status === "running"),
            );
    }

    async issueDuty(
        ctx: Context,
        agentId: string,
        input: IssueDutyInput,
    ): Promise<{ duty: DutyBinding; run: DutyRun }> {
        this.#assertAgentId(agentId);
        if (!Value.Check(issueDutyInputSchema, input)) throw new Error("Duty issuance is invalid.");
        return await this.#mutate(ctx, agentId, async (txCtx) => {
            const existing = await this.duty(txCtx, agentId);
            if (existing !== undefined && existing.status !== "stopped") {
                if (existing.dutyId === input.dutyId && existing.tenureId === input.tenureId) {
                    const runs = await this.runs(txCtx, agentId);
                    const run = [...runs]
                        .reverse()
                        .find(
                            (candidate) =>
                                candidate.dutyId === input.dutyId &&
                                candidate.tenureId === input.tenureId,
                        );
                    if (run !== undefined) return { duty: existing, run };
                }
                throw new Error("This agent already has an unfinished Duty.");
            }
            const now = Date.now();
            const duty: DutyBinding = {
                agentId,
                allowedTools: [...input.allowedTools],
                charter: input.charter.trim(),
                createdAt: now,
                dutyId: input.dutyId,
                permissionCeiling: input.permissionCeiling,
                status: "active",
                tenureId: input.tenureId,
                updatedAt: now,
            };
            if (!Value.Check(dutyBindingSchema, duty)) throw new Error("Duty binding is invalid.");
            await this.#database.writeBinding(txCtx, duty);
            const run = await this.#createRun(txCtx, duty, input.trigger);
            await this.#wake(txCtx, duty, run);
            return { duty: structuredClone(duty), run: structuredClone(run) };
        });
    }

    async activateDuty(ctx: Context, agentId: string, trigger: string): Promise<DutyRun> {
        return await this.#mutate(ctx, agentId, async (txCtx) => {
            const duty = await this.duty(txCtx, agentId);
            if (duty?.status !== "active") throw new Error("Only an active Duty can be activated.");
            const current = await this.currentRun(txCtx, agentId);
            if (current !== undefined) return current;
            const run = await this.#createRun(txCtx, duty, trigger.trim());
            await this.#wake(txCtx, duty, run);
            return structuredClone(run);
        });
    }

    async changeDutyStatus(
        ctx: Context,
        agentId: string,
        status: DutyStatus,
    ): Promise<DutyBinding> {
        if (!Value.Check(dutyStatusSchema, status)) throw new Error("Duty status is invalid.");
        return await this.#mutate(ctx, agentId, async (txCtx) => {
            const duty = await this.#changeStatus(txCtx, agentId, status);
            if (status === "active") {
                const current = await this.currentRun(txCtx, agentId);
                if (current === undefined) {
                    const run = await this.#createRun(txCtx, duty, "Duty resumed by its issuer.");
                    await this.#wake(txCtx, duty, run);
                }
            }
            if (status !== "active") this.#abortAfterCommit(txCtx, agentId);
            return duty;
        });
    }

    async #changeStatus(ctx: Context, agentId: string, status: DutyStatus): Promise<DutyBinding> {
        const duty = await this.duty(ctx, agentId);
        if (duty === undefined) throw new Error("This agent does not have a Duty.");
        if (duty.status === "stopped" && status === "active")
            throw new Error("A stopped Duty cannot be resumed.");
        if (duty.status === status) return duty;
        if (status !== "active") await this.#cancelCurrentRun(ctx, agentId, status);
        const updated = { ...duty, status, updatedAt: Date.now() };
        await this.#database.writeBinding(ctx, updated);
        return structuredClone(updated);
    }

    async #createRun(ctx: Context, duty: DutyBinding, trigger: string): Promise<DutyRun> {
        const normalizedTrigger = trigger.trim();
        if (normalizedTrigger.length === 0) throw new Error("Duty trigger must not be empty.");
        const run: DutyRun = {
            agentId: duty.agentId,
            createdAt: Date.now(),
            dutyId: duty.dutyId,
            runId: globalThis.crypto.randomUUID(),
            status: "queued",
            tenureId: duty.tenureId,
            trigger: normalizedTrigger,
        };
        if (!Value.Check(dutyRunSchema, run)) throw new Error("Duty run is invalid.");
        await this.#database.writeRun(ctx, run);
        return run;
    }

    async #cancelCurrentRun(
        ctx: Context,
        agentId: string,
        status: Exclude<DutyStatus, "active">,
    ): Promise<void> {
        const run = await this.currentRun(ctx, agentId);
        if (run === undefined) return;
        await this.#database.writeRun(ctx, {
            ...run,
            error: `Duty ${status} by its issuer.`,
            settledAt: Date.now(),
            status: "failed",
        });
    }

    async #wake(ctx: Context, duty: DutyBinding, run: DutyRun): Promise<void> {
        const agents = this.#agents;
        if (agents === undefined) throw new Error("Issuing a Duty requires the agent system.");
        await agents.send(
            ctx,
            duty.agentId,
            {
                role: "user",
                content: [
                    {
                        type: "text",
                        text: `Execute Duty run ${run.runId}.\nTrigger: ${run.trigger}\nCharter: ${duty.charter}`,
                    },
                ],
            },
            {
                id: dutyMessageId(duty.agentId, run.runId),
                metadata: {
                    ...AGENT_MESSAGE_ORIGIN_METADATA,
                    ...senderAgentIdMetadata(duty.agentId),
                    [DUTY_RUN_METADATA_KEY]: run.runId,
                },
                permissionMode: duty.permissionCeiling,
            },
        );
    }

    async #observeAcceptedRun(
        ctx: Context,
        scope: AgentModuleScope,
        accepted: AgentBaseAcceptedMessage,
    ): Promise<void> {
        const runId = accepted.metadata?.[DUTY_RUN_METADATA_KEY];
        if (typeof runId !== "string" || !Value.Check(dutyIdSchema, runId)) return;
        const value = await this.#database.run(ctx, runId);
        if (!Value.Check(dutyRunSchema, value) || value.agentId !== scope.agent.id)
            throw new Error("Accepted Duty run is invalid.");
        if (value.status === "queued") {
            await this.#database.writeRun(ctx, {
                ...value,
                startedAt: Date.now(),
                status: "running",
            });
        }
        await scope.runKV.write(ctx, DUTY_RUN_KV_KEY, runId);
    }

    async #settleObservedRun(
        ctx: Context,
        scope: AgentModuleScope,
        settlement: AgentBaseSettlement,
    ): Promise<void> {
        const runId = await scope.runKV.read(ctx, DUTY_RUN_KV_KEY);
        if (runId === undefined) return;
        if (typeof runId !== "string" || !Value.Check(dutyIdSchema, runId))
            throw new Error("Observed Duty run ID is invalid.");
        const value = await this.#database.run(ctx, runId);
        if (!Value.Check(dutyRunSchema, value) || value.agentId !== scope.agent.id)
            throw new Error("Observed Duty run is invalid.");
        if (value.status !== "running" && value.status !== "queued") return;
        const settled: DutyRun = {
            ...value,
            ...(settlement.error === undefined ? {} : { error: settlement.error.slice(0, 8_000) }),
            settledAt: Date.now(),
            status: settlement.error === undefined ? "completed" : "failed",
        };
        await this.#database.writeRun(ctx, settled);
    }

    async #enforceToolCall(
        ctx: Context,
        scope: AgentModuleScope,
        call: AgentBaseToolCall,
    ): Promise<AgentBaseToolCallDecision | undefined> {
        const duty = await this.duty(ctx, scope.agent.id);
        if (duty === undefined || duty.status === "stopped") return undefined;
        if (
            duty.status === "paused" ||
            (!DUTY_CONTROL_TOOLS.has(call.tool.name) && !duty.allowedTools.includes(call.tool.name))
        ) {
            return {
                type: "answer",
                isError: true,
                content: [
                    {
                        type: "text",
                        text:
                            duty.status === "paused"
                                ? "This Duty is paused; only Duty inspection is allowed."
                                : `Tool "${call.tool.name}" is outside this Duty's allowed-tool ceiling.`,
                    },
                ],
            };
        }
        return {
            type: "run",
            permissionMode: narrowerMode(scope.agent.permissionMode, duty.permissionCeiling),
        };
    }

    #abortAfterCommit(ctx: Context, agentId: string): void {
        const agents = this.#agents;
        if (agents === undefined) return;
        afterCommit(ctx, async (postCommitCtx) => {
            try {
                await agents.abort(postCommitCtx, agentId);
            } catch (error: unknown) {
                postCommitCtx.log.error(
                    { error, agentId },
                    "Duty could not stop the agent after its status changed.",
                );
            }
        });
    }

    async #mutate<Result>(
        ctx: Context,
        agentId: string,
        work: (txCtx: Context) => Promise<Result>,
    ): Promise<Result> {
        this.#assertAgentId(agentId);
        const previous = this.#mutations.get(agentId) ?? Promise.resolve();
        const run = previous.then(async () => await ctx.inTx(work));
        const settled = run.then(
            () => undefined,
            () => undefined,
        );
        this.#mutations.set(agentId, settled);
        try {
            return await run;
        } finally {
            if (this.#mutations.get(agentId) === settled) this.#mutations.delete(agentId);
        }
    }

    #assertAgentId(agentId: string): void {
        if (!Value.Check(dutyAgentIdSchema, agentId)) throw new Error("Duty agent ID is invalid.");
    }
}

function permissionRank(mode: AgentPermissionMode): number {
    return { read_only: 0, workspace_write: 1, auto: 2, full_access: 3 }[mode];
}

function narrowerMode(left: AgentPermissionMode, right: AgentPermissionMode): AgentPermissionMode {
    return permissionRank(left) <= permissionRank(right) ? left : right;
}

function dutyMessageId(agentId: string, runId: string): string {
    return `d${createHash("sha256")
        .update(JSON.stringify([agentId, runId]), "utf8")
        .digest("hex")
        .slice(0, 31)}`;
}
