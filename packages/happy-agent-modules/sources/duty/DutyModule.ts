import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";

import {
    agentDatabase,
    agentDatabaseRun,
    withAgentDatabase,
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
import { afterCommit, asyncLock, detach, type Context } from "@steve.kite/stdlib";

import type { ConfigModule } from "../config/index.js";
import { AGENT_MESSAGE_ORIGIN_METADATA, senderAgentIdMetadata } from "../impl/messageOrigin.js";
import type { ProjectsModule } from "../projects/index.js";
import {
    dutyAgentIdSchema,
    dutyBindingSchema,
    dutyDeclarationSchema,
    dutyIdSchema,
    dutyRunSchema,
    dutyReconcileOptionsSchema,
    dutyStatusSchema,
    issueDutyInputSchema,
    MAX_DUTY_INTERVAL_MS,
    type DutyBinding,
    type DutyDeclaration,
    type DutyReconciliation,
    type DutyReconcileOptions,
    type DutyRosterAuthority,
    type DutyRun,
    type DutyStatus,
    type IssueDutyInput,
} from "./Duty.js";
import { dutyDeclarationHash, readDutyRoster } from "./DutyRoster.js";
import { DutyDatabase } from "./impl/DutyDatabase.js";
import { ensureDutyAgent } from "./impl/ensureDutyAgent.js";
import { formatDutyForModel } from "./impl/formatDutyForModel.js";
import { dutyControlTools } from "./tools/dutyControlTools.js";
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
    readonly #config: ConfigModule | undefined;
    readonly #mutations = new Map<string, Promise<void>>();
    readonly #projects: ProjectsModule | undefined;
    readonly #reconciliation = asyncLock({ reentry: "allow" });
    /** Live periodic alarms, one per bound agent. */
    readonly #timers = new Map<string, ReturnType<typeof setTimeout>>();
    #agents: AgentSystemRef | undefined;
    #wakeCtx: Context | undefined;

    constructor(config?: ConfigModule, projects?: ProjectsModule) {
        this.#config = config;
        this.#projects = projects;
    }

    readonly beforeStart = (ctx: Context, agents: AgentSystemRef): AgentModuleHooks => {
        this.#agents = agents;
        // A periodic wake outlives the call that issued the Duty, so it runs on a context of the
        // module's own. Detaching drops the caller's lifetime, which would take the database with
        // it, so the database is carried back on deliberately.
        const database = agentDatabase(ctx);
        if (database !== undefined) {
            this.#wakeCtx = withAgentDatabase(detach(ctx).named("duty"), database);
        }
        return {
            agentArchivedTransact: async (ctx, _scope, agent) => {
                const binding = await this.duty(ctx, agent.id);
                if (binding?.status === "active") await this.#changeStatus(ctx, agent.id, "paused");
            },
            tools: async (ctx, scope) => {
                const inspection = getDutyTool(this, scope.agent.id);
                const binding = await this.duty(ctx, scope.agent.id);
                if (
                    binding !== undefined ||
                    (await agents.parentOf(ctx, scope.agent.id)) !== null
                ) {
                    return [inspection];
                }
                return [inspection, ...dutyControlTools(this)];
            },
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

    /** Read, reconcile, and recover the local machine roster after projects become available. */
    async open(ctx: Context): Promise<DutyReconciliation> {
        const config = this.#config;
        const projects = this.#projects;
        if (config === undefined || projects === undefined) {
            throw new Error("Opening the Duty roster requires configuration and projects.");
        }
        const roster = await readDutyRoster(config.configuration.paths.configHome);
        for (const notice of roster.notices) ctx.log.warn(notice, {});
        const outcome = await this.reconcile(ctx, roster.declarations, {
            authoritative: roster.authoritative,
        });
        for (const notice of outcome.notices) ctx.log.warn(notice, {});
        await this.recover(ctx);
        return outcome;
    }

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

    /**
     * Bring the machine's declared roster into effect.
     *
     * Reconciliation is idempotent, because it runs on every start. An identical declaration keeps
     * its run in flight; changed authority is stopped and reissued; a clean roster also stops every
     * roster-owned Duty it no longer declares. Manual and RPC-issued Duties are never pruned.
     *
     * Invalid or duplicate input disables pruning for the whole pass. A declaration that cannot be
     * bound is reported and skipped, so one unusable folder does not block the other Duties.
     */
    async reconcile(
        ctx: Context,
        declarations: readonly DutyDeclaration[],
        options: DutyReconcileOptions = {},
    ): Promise<DutyReconciliation> {
        if (!Value.Check(dutyReconcileOptionsSchema, options)) {
            throw new Error("Duty reconciliation options are invalid.");
        }
        return await this.#reconciliation.runInLock(ctx, async (lockCtx) => {
            const issued: string[] = [];
            const unchanged: string[] = [];
            const stopped = new Set<string>();
            const updated: string[] = [];
            const notices: string[] = [];
            const valid: DutyDeclaration[] = [];
            const declared = new Set<string>();
            let complete = true;
            for (const declaration of declarations) {
                if (!Value.Check(dutyDeclarationSchema, declaration)) {
                    notices.push("A Duty declaration was rejected as invalid.");
                    complete = false;
                    continue;
                }
                if (declared.has(declaration.dutyId)) {
                    notices.push(`Duty "${declaration.dutyId}" was declared more than once.`);
                    complete = false;
                    continue;
                }
                declared.add(declaration.dutyId);
                valid.push(structuredClone(declaration));
            }

            if ((options.authoritative ?? true) && complete) {
                for (const binding of await this.#bindings(lockCtx)) {
                    if (
                        binding.roster !== undefined &&
                        binding.status !== "stopped" &&
                        !declared.has(binding.dutyId)
                    ) {
                        await this.changeDutyStatus(lockCtx, binding.agentId, "stopped");
                        stopped.add(binding.dutyId);
                    }
                }
            }

            const agents = this.#agents;
            const projects = this.#projects;
            if (agents === undefined) throw new Error("Reconciling Duties requires the agents.");
            if (projects === undefined) throw new Error("Reconciling Duties requires projects.");
            for (const declaration of valid) {
                try {
                    const agentId = await ensureDutyAgent(lockCtx, projects, agents, declaration);
                    const declarationHash = dutyDeclarationHash(declaration);
                    const existing = (await this.#bindings(lockCtx)).filter(
                        (binding) =>
                            binding.roster !== undefined &&
                            binding.dutyId === declaration.dutyId &&
                            binding.status !== "stopped",
                    );
                    const current = existing.find((binding) => binding.agentId === agentId);
                    if (
                        current !== undefined &&
                        current.roster?.declarationHash === declarationHash
                    ) {
                        this.#arm(current);
                        unchanged.push(declaration.dutyId);
                        continue;
                    }
                    for (const binding of existing) {
                        await this.changeDutyStatus(lockCtx, binding.agentId, "stopped");
                    }
                    await this.#issueDuty(
                        lockCtx,
                        agentId,
                        {
                            allowedTools: declaration.allowedTools,
                            charter: declaration.charter,
                            dutyId: declaration.dutyId,
                            ...(declaration.every === undefined
                                ? {}
                                : { every: declaration.every }),
                            permissionCeiling: declaration.permissionCeiling,
                            tenureId: declaration.tenureId,
                            trigger: declaration.trigger,
                        },
                        { declarationHash, project: declaration.project },
                    );
                    if (existing.length === 0) issued.push(declaration.dutyId);
                    else updated.push(declaration.dutyId);
                } catch (error: unknown) {
                    notices.push(
                        `Duty "${declaration.dutyId}" was not bound: ${
                            error instanceof Error ? error.message : "the binding failed."
                        }`,
                    );
                }
            }
            return { issued, notices, stopped: [...stopped], unchanged, updated };
        });
    }

    /**
     * Re-drive whatever the last process left behind.
     *
     * A wake is idempotent — Agent Base accepts one message ID once — so re-sending the wake for an
     * unsettled run is safe whether the agent already has it or the crash lost it. That is what
     * keeps a Duty from wedging: without this, a run interrupted between issuance and acceptance
     * stays `queued` forever and `activateDuty` keeps handing back the same dead run.
     */
    async recover(ctx: Context): Promise<void> {
        for (const binding of await this.#bindings(ctx)) {
            if (binding.status !== "active") continue;
            try {
                const run = await this.currentRun(ctx, binding.agentId);
                if (run !== undefined) await this.#wake(ctx, binding, run);
                this.#arm(binding);
            } catch (error: unknown) {
                ctx.log.error(
                    { agentId: binding.agentId, dutyId: binding.dutyId, error },
                    "A Duty could not be recovered after this process started.",
                );
            }
        }
    }

    /** Drop every periodic alarm. Called when the runtime closes; safe to repeat. */
    stop(): void {
        for (const handle of this.#timers.values()) clearTimeout(handle);
        this.#timers.clear();
    }

    async issueDuty(
        ctx: Context,
        agentId: string,
        input: IssueDutyInput,
    ): Promise<{ duty: DutyBinding; run: DutyRun }> {
        return await this.#issueDuty(ctx, agentId, input);
    }

    /**
     * Issue a machine-owned Duty to a dedicated durable holder.
     *
     * This is the local control path used by an ordinary Rig session. A changed tenure creates a
     * fresh holder and stops the previous one before the replacement is woken. Unlike roster-owned
     * bindings, an interactively issued Duty is not pruned by a missing roster entry on restart.
     */
    async issueManagedDuty(
        ctx: Context,
        declaration: DutyDeclaration,
    ): Promise<{ duty: DutyBinding; run: DutyRun }> {
        if (!Value.Check(dutyDeclarationSchema, declaration)) {
            throw new Error("Duty declaration is invalid.");
        }
        return await this.#reconciliation.runInLock(ctx, async (lockCtx) => {
            const agents = this.#agents;
            const projects = this.#projects;
            if (agents === undefined || projects === undefined) {
                throw new Error("Issuing a managed Duty requires the agent system and projects.");
            }
            const agentId = await ensureDutyAgent(lockCtx, projects, agents, declaration);
            const existing = (await this.#bindings(lockCtx)).filter(
                (binding) => binding.dutyId === declaration.dutyId && binding.status !== "stopped",
            );
            const current = existing.find((binding) => binding.agentId === agentId);
            if (current !== undefined && matchesDeclaration(current, declaration)) {
                const run = [...(await this.runs(lockCtx, agentId))]
                    .reverse()
                    .find(
                        (candidate) =>
                            candidate.dutyId === declaration.dutyId &&
                            candidate.tenureId === declaration.tenureId,
                    );
                if (run !== undefined) return { duty: current, run };
            }
            for (const binding of existing) {
                await this.changeDutyStatus(lockCtx, binding.agentId, "stopped");
            }
            return await this.#issueDuty(lockCtx, agentId, {
                allowedTools: declaration.allowedTools,
                charter: declaration.charter,
                dutyId: declaration.dutyId,
                ...(declaration.every === undefined ? {} : { every: declaration.every }),
                permissionCeiling: declaration.permissionCeiling,
                tenureId: declaration.tenureId,
                trigger: declaration.trigger,
            });
        });
    }

    /** Every valid local binding, including stopped holders retained for audit history. */
    async duties(ctx: Context): Promise<readonly DutyBinding[]> {
        return await this.#bindings(ctx);
    }

    /** Resolve the one live holder for a machine Duty ID. */
    async activeDuty(ctx: Context, dutyId: string): Promise<DutyBinding | undefined> {
        if (!Value.Check(dutyIdSchema, dutyId)) throw new Error("Duty ID is invalid.");
        const active = (await this.#bindings(ctx)).filter(
            (binding) => binding.dutyId === dutyId && binding.status !== "stopped",
        );
        if (active.length > 1) throw new Error(`Duty "${dutyId}" has multiple live holders.`);
        return active[0];
    }

    async #issueDuty(
        ctx: Context,
        agentId: string,
        input: IssueDutyInput,
        roster?: DutyRosterAuthority,
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
                ...(input.every === undefined
                    ? {}
                    : { every: input.every, nextWakeAt: now + input.every }),
                permissionCeiling: input.permissionCeiling,
                ...(roster === undefined ? {} : { roster: structuredClone(roster) }),
                status: "active",
                tenureId: input.tenureId,
                updatedAt: now,
            };
            if (!Value.Check(dutyBindingSchema, duty)) throw new Error("Duty binding is invalid.");
            await this.#database.writeBinding(txCtx, duty);
            const run = await this.#createRun(txCtx, duty, input.trigger);
            await this.#wake(txCtx, duty, run);
            // Arming only after the commit keeps a rolled-back issuance from leaving a live alarm
            // for a Duty this machine never actually took on.
            afterCommit(txCtx, () => {
                this.#arm(duty);
            });
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
            // A paused or stopped Duty must stop waking itself, and only the committed status may
            // decide that: an alarm dropped by a transaction that rolls back would never come back.
            afterCommit(txCtx, () => {
                if (status === "active") this.#arm(duty);
                else this.#disarm(agentId);
            });
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
        const model = this.#config?.models[0];
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
                ...(model === undefined
                    ? {}
                    : {
                          effort: model.defaultEffort,
                          model: model.id,
                          provider: model.providerId,
                      }),
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
        // Message metadata is untrusted input, and this hook runs inside the transaction that
        // accepts the message: throwing here rolls that acceptance back, so a message naming a run
        // that does not exist — or one belonging to another agent — could never be accepted and
        // would block the agent's queue permanently. An unrecognised claim is ignored instead,
        // which fails closed: the run simply goes uncorrelated.
        if (!Value.Check(dutyRunSchema, value) || value.agentId !== scope.agent.id) {
            ctx.log.debug(
                { agentId: scope.agent.id, runId },
                "A message claimed a Duty run this agent does not hold.",
            );
            return;
        }
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
        await this.#scheduleNextWake(ctx, scope.agent.id);
    }

    /**
     * Set a periodic Duty's next due time, measured from the moment the last run settled.
     *
     * Measuring from settlement rather than from the previous due time is what keeps the interval a
     * gap between runs instead of a rate: a run that takes longer than the interval cannot queue up
     * a backlog of wakes it will never catch up with.
     */
    async #scheduleNextWake(ctx: Context, agentId: string): Promise<void> {
        const duty = await this.duty(ctx, agentId);
        if (duty?.every === undefined || duty.status !== "active") return;
        const updated: DutyBinding = {
            ...duty,
            nextWakeAt: Date.now() + duty.every,
            updatedAt: Date.now(),
        };
        await this.#database.writeBinding(ctx, updated);
        afterCommit(ctx, () => {
            this.#arm(updated);
        });
    }

    #arm(duty: DutyBinding): void {
        this.#disarm(duty.agentId);
        if (duty.status !== "active" || duty.every === undefined) return;
        const dueAt = duty.nextWakeAt ?? Date.now() + duty.every;
        // A Duty interval is capped at 24 hours, which one Node timer expresses exactly, so no
        // chunked re-arming is needed. Overdue after a long shutdown means due now.
        const delay = Math.max(0, Math.min(dueAt - Date.now(), MAX_DUTY_INTERVAL_MS));
        const handle = setTimeout(() => {
            this.#timers.delete(duty.agentId);
            void this.#fire(duty.agentId);
        }, delay);
        // An unreferenced timer never keeps the process alive on a Duty's behalf.
        (handle as { unref?: () => void }).unref?.();
        this.#timers.set(duty.agentId, handle);
    }

    #disarm(agentId: string): void {
        const handle = this.#timers.get(agentId);
        if (handle !== undefined) clearTimeout(handle);
        this.#timers.delete(agentId);
    }

    /**
     * Start the run one interval has become due for.
     *
     * `activateDuty` hands back the run already in flight rather than minting a second one, so a
     * Duty still working when its next wake comes round is left alone — but its clock has to be
     * restarted here, or the alarm this callback consumed would be the last one it ever had.
     */
    async #fire(agentId: string): Promise<void> {
        const ctx = this.#wakeCtx;
        if (ctx === undefined) return;
        try {
            await this.activateDuty(ctx, agentId, "This Duty's own interval came due.");
            const duty = await this.duty(ctx, agentId);
            if (duty !== undefined && this.#timers.get(agentId) === undefined) {
                await ctx.inTx(async (txCtx) => {
                    await this.#scheduleNextWake(txCtx, agentId);
                });
            }
        } catch (error: unknown) {
            ctx.log.error({ agentId, error }, "A Duty's periodic wake failed.");
            const duty = await this.duty(ctx, agentId).catch(() => undefined);
            // A failed wake must still leave a clock behind, or the Duty silently stops watching.
            if (duty !== undefined)
                this.#arm({ ...duty, nextWakeAt: Date.now() + (duty.every ?? 0) });
        }
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
        const clamped = narrowerMode(scope.agent.permissionMode, duty.permissionCeiling);
        // Decisions fold last-wins, and this module is ordered after the permission broker, so
        // naming a mode here overwrites whatever that broker decided. When the ceiling is not
        // actually narrower than the agent's own mode it has nothing to say, and saying it anyway
        // would silently discard an elevation a person had just approved.
        if (clamped === scope.agent.permissionMode) return undefined;
        return { type: "run", permissionMode: clamped };
    }

    async #bindings(ctx: Context): Promise<readonly DutyBinding[]> {
        const values = await this.#database.bindings(ctx);
        const bindings: DutyBinding[] = [];
        for (const value of values) {
            // One unreadable row must not stop the Duties that are still intact from recovering.
            if (Value.Check(dutyBindingSchema, value)) bindings.push(structuredClone(value));
            else ctx.log.error({}, "A stored Duty binding was unreadable and has been skipped.");
        }
        return bindings;
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

function matchesDeclaration(binding: DutyBinding, declaration: DutyDeclaration): boolean {
    return (
        binding.charter === declaration.charter.trim() &&
        binding.tenureId === declaration.tenureId &&
        binding.permissionCeiling === declaration.permissionCeiling &&
        binding.every === declaration.every &&
        JSON.stringify([...binding.allowedTools].sort()) ===
            JSON.stringify([...declaration.allowedTools].sort())
    );
}

function dutyMessageId(agentId: string, runId: string): string {
    return `d${createHash("sha256")
        .update(JSON.stringify([agentId, runId]), "utf8")
        .digest("hex")
        .slice(0, 31)}`;
}
