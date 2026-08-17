import { createId } from "@paralleldrive/cuid2";
import { sql } from "drizzle-orm";
import {
    agentDatabaseRun,
    type AgentBasePersistedEvent,
    type AgentBaseSettlement,
    type AgentMetadata,
    type AgentModule,
    type AgentModuleHooks,
    type AgentModuleMigration,
    type AgentModuleScope,
    type AnyAgentTool,
} from "@slopus/happy-agent-base";
import { isSessionErrorDone, type SessionEvent } from "@slopus/happy-providers";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { afterCommit, type Context } from "@steve.kite/stdlib";

import type { CollaborationModule } from "../collaboration/CollaborationModule.js";
import type { ComputeResolver } from "../compute/ComputeResolver.js";
import { computePermissionsForContext } from "../compute/impl/computePermissionsForContext.js";
import { resolveComputePath } from "../compute/impl/resolveComputePath.js";
import {
    MAX_WORKFLOW_ARGS_BYTES,
    MAX_WORKFLOW_DESCRIPTION_LENGTH,
    MAX_WORKFLOW_ERROR_LENGTH,
    MAX_WORKFLOW_LOG_LINES,
    MAX_WORKFLOW_LOG_LINE_LENGTH,
    MAX_WORKFLOW_NAME_LENGTH,
    MAX_WORKFLOW_OUTPUT_CHARACTERS,
    MAX_WORKFLOW_PAGE_SIZE,
    MAX_WORKFLOW_SCRIPT_LENGTH,
    describeWorkflowStatus,
    isWorkflowTerminalStatus,
    workflowAgentIdSchema,
    workflowArgsSchema,
    workflowIdSchema,
    workflowLaunchInputSchema,
    workflowLogQuerySchema,
    workflowPageQuerySchema,
    workflowTimestampSchema,
    type WorkflowLaunchInput,
    type WorkflowLaunchRequest,
    type WorkflowLogPage,
    type WorkflowLogQuery,
    type WorkflowPage,
    type WorkflowPageQuery,
    type WorkflowRun,
    type WorkflowRunningRun,
} from "./Workflow.js";
import {
    MAX_WORKFLOW_POST_COMMIT_ERROR_LENGTH,
    workflowEventIdSchema,
    workflowModuleListenerSchema,
    workflowPostCommitErrorSchema,
    type WorkflowEvent,
} from "./WorkflowEvent.js";
import {
    WORKFLOWS_MIGRATION_KEY,
    WORKFLOW_AGENT_CALLS_TABLE,
    WORKFLOW_CHECKPOINTS_TABLE,
    WORKFLOW_LAUNCHES_TABLE,
    WORKFLOW_LOGS_TABLE,
    WORKFLOW_PROOFS_TABLE,
    WORKFLOW_RECEIPTS_TABLE,
    WORKFLOW_RUNS_TABLE,
    appendWorkflowLogs,
    completeWorkflowAgentCall,
    readUnansweredWorkflowCollaborators,
    readUnfinishedWorkflowRuns,
    readWorkflowAgentCalls,
    readWorkflowCheckpoint,
    readWorkflowLaunch,
    readWorkflowLogPage,
    readWorkflowPage,
    readWorkflowRun,
    writeWorkflowAgentCall,
    writeWorkflowAgentCallOutput,
    writeWorkflowCheckpoint,
    writeWorkflowLaunch,
    writeWorkflowRun,
} from "./WorkflowDatabase.js";
import {
    WorkflowScriptRunner,
    type WorkflowAgentResult,
    type WorkflowAgentStart,
} from "./runner/WorkflowScriptRunner.js";
import { serializeWorkflowValue } from "./runner/serializeWorkflowValue.js";
import { cancelWorkflowTool } from "./tools/cancel_workflow.js";
import { listWorkflowsTool } from "./tools/list_workflows.js";
import { resumeWorkflowTool } from "./tools/resume_workflow.js";
import { runWorkflowTool } from "./tools/run_workflow.js";
import { waitWorkflowTool } from "./tools/wait_workflow.js";
import { workflowLogsTool } from "./tools/workflow_logs.js";
import { workflowStatusTool } from "./tools/workflow_status.js";

const workflowModuleOptionsSchema = Type.Object(
    {
        enabled: Type.Optional(Type.Boolean()),
        /** Where a run lives once the tool call that started it has returned. */
        runContext: Type.Unsafe<Context>(Type.Object({}, { additionalProperties: true })),
        /** How this module starts the agents a script asks for. */
        collaboration: Type.Unsafe<CollaborationModule>(
            Type.Object({}, { additionalProperties: true }),
        ),
        /** The agent's own filesystem, used only to read a script the model named by path. */
        compute: Type.Optional(
            Type.Unsafe<ComputeResolver>(Type.Object({}, { additionalProperties: true })),
        ),
        clock: Type.Optional(Type.Function([], workflowTimestampSchema)),
        listener: Type.Optional(workflowModuleListenerSchema),
        eventIdFactory: Type.Optional(Type.Function([], workflowEventIdSchema)),
        collaboratorIdFactory: Type.Optional(Type.Function([], Type.String())),
        maxPageSize: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_WORKFLOW_PAGE_SIZE })),
        maxLogLines: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_WORKFLOW_LOG_LINES })),
        maxOutputCharacters: Type.Optional(
            Type.Integer({ minimum: 256, maximum: MAX_WORKFLOW_OUTPUT_CHARACTERS }),
        ),
        onPostCommitError: Type.Optional(
            Type.Function(
                [
                    Type.Unsafe<Context>(Type.Object({}, { additionalProperties: true })),
                    Type.Unsafe<WorkflowEvent>(Type.Object({}, { additionalProperties: true })),
                    workflowPostCommitErrorSchema,
                ],
                Type.Union([Type.Void(), Type.Promise(Type.Void())]),
            ),
        ),
    },
    { additionalProperties: false },
);

export { workflowModuleOptionsSchema };
export type WorkflowModuleOptions = Static<typeof workflowModuleOptionsSchema>;

const DEFAULT_PAGE_SIZE = 50;
const DEFAULT_MAX_LOG_LINES = 200;
const DEFAULT_MAX_OUTPUT = 12_000;
const EXECUTION_MIGRATION_KEY = "003-workflows-execution";
const DROP_WORKFLOW_REPLAY_TABLES_MIGRATION_KEY = "002-workflows-drop-replay-evidence";

/** What a run needs from this process while it is actually executing. */
interface LiveWorkflowRun {
    readonly controller: AbortController;
    readonly finished: Promise<void>;
}

/** One agent call this process is waiting on, keyed by the collaborator answering it. */
interface WorkflowAgentWaiter {
    resolve(answer: string): void;
    reject(error: Error): void;
}

/**
 * Workflows run one sandboxed Python script that puts real agents to work.
 *
 * The script has no filesystem, shell, environment, or network of its own; it decides who does
 * what and in what order, and every agent it asks for is an ordinary collaborator created through
 * the collaboration module. So a workflow is not a second kind of agent runtime — it is a way of
 * writing down a plan that would otherwise have to be carried out one `create_agent` call at a
 * time, with the model doing the bookkeeping.
 *
 * Nothing outside this module executes a workflow. The module owns the runs, their logs, their
 * checkpoints, and the answers their agents gave.
 *
 * A collaborator's answer comes back through the same settlement the collaboration module reports
 * with, but it is not reported into anyone's conversation: the workflow asked the question and the
 * workflow reads the answer, so a hundred-agent run leaves a person's chat exactly as it found it.
 */
export class WorkflowsModule implements AgentModule {
    readonly name = "workflows";

    readonly #options: WorkflowModuleOptions;
    readonly #enabled: boolean;
    readonly #collaboration: CollaborationModule;
    readonly #compute: ComputeResolver | undefined;
    readonly #runContext: Context;
    readonly #maxPageSize: number;
    readonly #maxLogLines: number;
    readonly #maxOutputCharacters: number;

    readonly #live = new Map<string, LiveWorkflowRun>();
    readonly #waiters = new Map<string, WorkflowAgentWaiter>();

    readonly migrations: readonly AgentModuleMigration[] = [
        [
            WORKFLOWS_MIGRATION_KEY,
            async (ctx) => {
                await agentDatabaseRun(
                    ctx.db,
                    sql`CREATE TABLE IF NOT EXISTS ${sql.raw(WORKFLOW_RUNS_TABLE)} (
                        agent_id TEXT NOT NULL,
                        id TEXT NOT NULL,
                        workflow TEXT NOT NULL,
                        status TEXT NOT NULL,
                        created_at BIGINT NOT NULL,
                        updated_at BIGINT NOT NULL,
                        run_json TEXT NOT NULL,
                        PRIMARY KEY (agent_id, id)
                    )`,
                );
                await agentDatabaseRun(
                    ctx.db,
                    sql`CREATE INDEX IF NOT EXISTS ${sql.raw(`${WORKFLOW_RUNS_TABLE}_agent_status_id`)}
                        ON ${sql.raw(WORKFLOW_RUNS_TABLE)} (agent_id, status, id)`,
                );
                await agentDatabaseRun(
                    ctx.db,
                    sql`CREATE TABLE IF NOT EXISTS ${sql.raw(WORKFLOW_LOGS_TABLE)} (
                        agent_id TEXT NOT NULL,
                        run_id TEXT NOT NULL,
                        position BIGINT NOT NULL,
                        text TEXT NOT NULL,
                        PRIMARY KEY (agent_id, run_id, position)
                    )`,
                );
                await agentDatabaseRun(
                    ctx.db,
                    sql`CREATE TABLE IF NOT EXISTS ${sql.raw(WORKFLOW_RECEIPTS_TABLE)} (
                        agent_id TEXT NOT NULL,
                        operation_id TEXT NOT NULL,
                        value_json TEXT NOT NULL,
                        PRIMARY KEY (agent_id, operation_id)
                    )`,
                );
                await agentDatabaseRun(
                    ctx.db,
                    sql`CREATE TABLE IF NOT EXISTS ${sql.raw(WORKFLOW_PROOFS_TABLE)} (
                        agent_id TEXT NOT NULL,
                        operation_id TEXT NOT NULL,
                        value_json TEXT NOT NULL,
                        PRIMARY KEY (agent_id, operation_id)
                    )`,
                );
            },
        ],
        [
            DROP_WORKFLOW_REPLAY_TABLES_MIGRATION_KEY,
            async (ctx) => {
                await agentDatabaseRun(
                    ctx.db,
                    sql`DROP TABLE IF EXISTS ${sql.raw(WORKFLOW_RECEIPTS_TABLE)}`,
                );
                await agentDatabaseRun(
                    ctx.db,
                    sql`DROP TABLE IF EXISTS ${sql.raw(WORKFLOW_PROOFS_TABLE)}`,
                );
            },
        ],
        [
            EXECUTION_MIGRATION_KEY,
            async (ctx) => {
                await agentDatabaseRun(
                    ctx.db,
                    sql`CREATE TABLE IF NOT EXISTS ${sql.raw(WORKFLOW_CHECKPOINTS_TABLE)} (
                        agent_id TEXT NOT NULL,
                        run_id TEXT NOT NULL,
                        snapshot BLOB NOT NULL,
                        next_call_index BIGINT NOT NULL,
                        phase TEXT NOT NULL,
                        PRIMARY KEY (agent_id, run_id)
                    )`,
                );
                await agentDatabaseRun(
                    ctx.db,
                    sql`CREATE TABLE IF NOT EXISTS ${sql.raw(WORKFLOW_AGENT_CALLS_TABLE)} (
                        agent_id TEXT NOT NULL,
                        run_id TEXT NOT NULL,
                        call_index BIGINT NOT NULL,
                        collaborator_id TEXT NOT NULL,
                        signature TEXT NOT NULL,
                        output_json TEXT,
                        error TEXT,
                        PRIMARY KEY (agent_id, run_id, call_index)
                    )`,
                );
                await agentDatabaseRun(
                    ctx.db,
                    sql`CREATE UNIQUE INDEX IF NOT EXISTS ${sql.raw(`${WORKFLOW_AGENT_CALLS_TABLE}_collaborator`)}
                        ON ${sql.raw(WORKFLOW_AGENT_CALLS_TABLE)} (collaborator_id)`,
                );
                await agentDatabaseRun(
                    ctx.db,
                    sql`CREATE TABLE IF NOT EXISTS ${sql.raw(WORKFLOW_LAUNCHES_TABLE)} (
                        agent_id TEXT NOT NULL,
                        run_id TEXT NOT NULL,
                        launch_json TEXT NOT NULL,
                        PRIMARY KEY (agent_id, run_id)
                    )`,
                );
            },
        ],
    ];

    constructor(options: WorkflowModuleOptions) {
        if (!Value.Check(workflowModuleOptionsSchema, options)) {
            throw new Error("The workflow module options are not valid.");
        }
        this.#options = options;
        this.#enabled = options.enabled ?? true;
        this.#collaboration = options.collaboration;
        this.#compute = options.compute;
        this.#runContext = options.runContext;
        this.#maxPageSize = options.maxPageSize ?? DEFAULT_PAGE_SIZE;
        this.#maxLogLines = options.maxLogLines ?? DEFAULT_MAX_LOG_LINES;
        this.#maxOutputCharacters = options.maxOutputCharacters ?? DEFAULT_MAX_OUTPUT;
    }

    readonly #hooks: AgentModuleHooks = {
        tools: async (ctx: Context, scope: AgentModuleScope): Promise<readonly AnyAgentTool[]> => {
            if (!this.#enabled) return [];
            // A script named by path is read through the agent's own filesystem, and the reviewer
            // is told exactly which boundary that crossing is, so the compute is resolved here
            // where the tools are built rather than at every call.
            const compute = await this.#compute?.resolve(ctx, scope.agent.id);
            return [
                runWorkflowTool(this, scope.agent.id, compute),
                listWorkflowsTool(this, scope.agent.id),
                workflowStatusTool(this, scope.agent.id),
                cancelWorkflowTool(this, scope.agent.id),
                resumeWorkflowTool(this, scope.agent.id),
                waitWorkflowTool(this, scope.agent.id),
                workflowLogsTool(this, scope.agent.id),
            ];
        },

        /**
         * A run whose process stopped is paused, not lost. Its script checkpointed itself at its
         * last agent call, so the work already paid for is still there and `resume_workflow`
         * continues from it.
         */
        afterStart: async (ctx: Context): Promise<void> => {
            if (!this.#enabled) return;
            const abandoned = await readUnfinishedWorkflowRuns(ctx);
            for (const run of abandoned) {
                if (this.#live.has(run.id)) continue;
                await ctx.inTx(async (txCtx) => {
                    const at = this.#now();
                    await this.#store(txCtx, {
                        ...run,
                        status: "paused",
                        pausedAt: at,
                        updatedAt: at,
                    });
                });
            }
        },

        /** The last thing a workflow's collaborator said, which is the answer it was asked for. */
        onEventTransact: async (
            ctx: Context,
            scope: AgentModuleScope,
            event: AgentBasePersistedEvent,
        ): Promise<void> => {
            if (event.type !== "text_end") return;
            if (!isWorkflowCollaborator(scope.agent.metadata)) return;
            const text = event.block.text.trim();
            if (text === "") return;
            await scope.runKV.write(ctx, LAST_TEXT_KEY, text);
        },

        /** Why a collaborator stopped, for the call that would otherwise wait for ever. */
        onEvent: async (
            ctx: Context,
            scope: AgentModuleScope,
            event: SessionEvent,
        ): Promise<void> => {
            if (!isSessionErrorDone(event)) return;
            if (!isWorkflowCollaborator(scope.agent.metadata)) return;
            const message = event.message.trim();
            await scope.runKV.write(
                ctx,
                LAST_ERROR_KEY,
                message === "" ? "The agent did not answer." : message,
            );
        },

        /**
         * A collaborator has stopped, so its call has its answer. Recording it in the settling
         * transaction is what makes a workflow survive a restart: the answer is durable before
         * anything in memory is told about it, and a resumed run reuses it rather than paying for
         * the same agent twice.
         */
        afterAgentSettledTransact: async (
            ctx: Context,
            scope: AgentModuleScope,
            _settlement: AgentBaseSettlement,
        ): Promise<void> => {
            if (!isWorkflowCollaborator(scope.agent.metadata)) return;
            const said = await scope.runKV.read(ctx, LAST_TEXT_KEY);
            const answer = typeof said === "string" ? said.trim() : "";
            const failure = await scope.runKV.read(ctx, LAST_ERROR_KEY);
            const reason = typeof failure === "string" ? failure.trim() : "";
            const result =
                answer === ""
                    ? { error: reason === "" ? "The agent finished without answering." : reason }
                    : { output: answer };
            await completeWorkflowAgentCall(ctx, scope.agent.id, result);
            afterCommit(ctx, () => {
                const waiter = this.#waiters.get(scope.agent.id);
                if (waiter === undefined) return;
                this.#waiters.delete(scope.agent.id);
                if ("output" in result) waiter.resolve(result.output);
                else waiter.reject(new Error(result.error));
            });
        },
    };

    readonly beforeStart = (): AgentModuleHooks => this.#hooks;

    /**
     * Start one workflow and return as soon as it is recorded as running. The script itself runs
     * on the module's own lifetime, so it outlives the tool call that asked for it.
     */
    async launch(
        ctx: Context,
        agentId: string,
        input: WorkflowLaunchInput,
        id: string,
    ): Promise<WorkflowRun> {
        this.#assertEnabled();
        if (!Value.Check(workflowAgentIdSchema, agentId) || !Value.Check(workflowIdSchema, id)) {
            throw new Error("The workflow identities are not valid.");
        }
        if (!Value.Check(workflowLaunchInputSchema, input)) {
            throw new Error("The workflow launch input is not valid.");
        }
        assertWorkflowArgsBounds(input.args);
        if ((await readWorkflowRun(ctx, agentId, id)) !== undefined) {
            throw new Error(`Workflow run "${id}" already exists.`);
        }
        const request = await this.#resolveLaunch(ctx, agentId, input, id);
        const at = this.#now();
        const run: WorkflowRun = {
            id,
            agentId,
            workflow: request.workflow,
            description: request.description,
            status: "running",
            agentCount: 0,
            logs: [],
            logsTruncated: false,
            createdAt: at,
            updatedAt: at,
            startedAt: at,
        };
        await ctx.inTx(async (txCtx) => {
            await writeWorkflowLaunch(txCtx, agentId, request);
            await this.#store(txCtx, run);
            await this.#publish(txCtx, "workflow_started", run);
        });
        this.#start(agentId, request, request.resumeFromRunId);
        return run;
    }

    /** One run, or nothing when this agent never started it. */
    async status(ctx: Context, agentId: string, id: string): Promise<WorkflowRun | undefined> {
        this.#assertEnabled();
        return await readWorkflowRun(ctx, agentId, id);
    }

    /** A bounded page of this agent's runs. */
    async list(
        ctx: Context,
        agentId: string,
        query: WorkflowPageQuery = {},
    ): Promise<WorkflowPage> {
        this.#assertEnabled();
        if (!Value.Check(workflowPageQuerySchema, query)) {
            throw new Error("The workflow page query is not valid.");
        }
        const limit = Math.min(query.limit ?? this.#maxPageSize, this.#maxPageSize);
        return await readWorkflowPage(ctx, agentId, { ...query, limit });
    }

    /** A bounded page of one run's progress notes. */
    async logs(ctx: Context, agentId: string, query: WorkflowLogQuery): Promise<WorkflowLogPage> {
        this.#assertEnabled();
        if (!Value.Check(workflowLogQuerySchema, query)) {
            throw new Error("The workflow log query is not valid.");
        }
        if ((await readWorkflowRun(ctx, agentId, query.id)) === undefined) {
            throw new Error(`Workflow run "${query.id}" was not found.`);
        }
        const limit = Math.min(query.limit ?? this.#maxLogLines, this.#maxLogLines);
        return await readWorkflowLogPage(ctx, agentId, { ...query, limit });
    }

    /**
     * Stop a run. The script is signalled and the run is recorded as cancelled; the agents already
     * working are told to stop too, and whatever they had already answered stays in the run's log.
     */
    async cancel(ctx: Context, agentId: string, id: string): Promise<WorkflowRun> {
        this.#assertEnabled();
        const run = await this.#require(ctx, agentId, id);
        if (isWorkflowTerminalStatus(run.status)) return run;
        this.#live.get(id)?.controller.abort();
        const working = await readUnansweredWorkflowCollaborators(ctx, agentId, id);
        const at = this.#now();
        const cancelled: WorkflowRun = {
            ...baseOf(run),
            status: "cancelled",
            finishedAt: at,
            updatedAt: at,
        };
        await ctx.inTx(async (txCtx) => {
            await this.#store(txCtx, cancelled);
            await this.#publish(txCtx, "workflow_finished", cancelled);
        });
        // Stopping the script stops nobody: its agents are separate and keep spending until they
        // are told. Their answers are of no use to a cancelled run, so they are interrupted after
        // the cancel is recorded — a collaborator that cannot be reached must not undo a cancel
        // the caller has already been told about.
        for (const collaboratorId of working) {
            try {
                await this.#collaboration.interruptAgent(ctx, agentId, collaboratorId);
            } catch (error: unknown) {
                ctx.log.warn(
                    "Failed to stop a cancelled workflow's agent.",
                    { runId: id, collaboratorId },
                    error,
                );
            }
        }
        return cancelled;
    }

    /** Continue a paused run from its last checkpoint, reusing every agent that already answered. */
    async resume(ctx: Context, agentId: string, id: string): Promise<WorkflowRun> {
        this.#assertEnabled();
        const run = await this.#require(ctx, agentId, id);
        if (run.status === "running") return run;
        if (run.status !== "paused") {
            throw new Error(`Workflow run "${id}" is ${describeWorkflowStatus(run.status)}.`);
        }
        const request = await this.#storedRequest(ctx, agentId, run);
        const at = this.#now();
        const resumed: WorkflowRun = { ...baseOf(run), status: "running", updatedAt: at };
        await ctx.inTx(async (txCtx) => {
            await this.#store(txCtx, resumed);
            await this.#publish(txCtx, "workflow_updated", resumed);
        });
        this.#start(agentId, request, id);
        return resumed;
    }

    /**
     * Wait for a run to stop. Cancelling the wait only stops waiting: the workflow keeps running,
     * and its status and logs are still there to read.
     */
    async wait(ctx: Context, agentId: string, id: string): Promise<WorkflowRun> {
        this.#assertEnabled();
        const run = await this.#require(ctx, agentId, id);
        if (isWorkflowTerminalStatus(run.status)) return run;
        const live = this.#live.get(id);
        if (live === undefined) return run;
        await raceWithLifetime(live.finished, ctx.lifetime);
        return await this.#require(ctx, agentId, id);
    }

    /** How one run reads to a model: what it is, where it got to, and what it has said so far. */
    formatRunForModel(run: WorkflowRun): string {
        const lines = [
            `${run.workflow} (${run.id}) is ${describeWorkflowStatus(run.status)}.`,
            run.description,
            `Agents started: ${String(run.agentCount)}.`,
            ...(run.phase === undefined ? [] : [`Current phase: ${run.phase}.`]),
            ...("error" in run ? [`It failed with: ${run.error}`] : []),
            ...("output" in run ? ["", "Result:", run.output] : []),
            ...(run.logs.length === 0
                ? []
                : [
                      "",
                      run.logsTruncated ? "Latest progress notes:" : "Progress notes:",
                      ...run.logs,
                  ]),
        ];
        return this.#bound(lines.join("\n"));
    }

    /** How a page of runs reads to a model. */
    formatPageForModel(page: WorkflowPage): string {
        if (page.runs.length === 0) return "No workflow runs.";
        const rows = page.runs.map(
            (run) =>
                `${run.workflow} (${run.id}) — ${describeWorkflowStatus(run.status)}, ${String(run.agentCount)} agents.`,
        );
        const more =
            page.nextCursor === undefined
                ? []
                : [`More runs follow; read from ${String(page.nextCursor)}.`];
        return this.#bound([...rows, ...more].join("\n"));
    }

    /** How a page of progress notes reads to a model. */
    formatLogsForModel(page: WorkflowLogPage): string {
        if (page.lines.length === 0) return "This workflow has recorded no progress notes.";
        const rows = page.lines.map((line) => `${String(line.position + 1)}. ${line.text}`);
        const more =
            page.nextCursor === undefined
                ? []
                : [`More notes follow; read from ${String(page.nextCursor)}.`];
        return this.#bound([...rows, ...more].join("\n"));
    }

    /** Read the script the launch names, from the model's own text or from the agent's disk. */
    async #resolveLaunch(
        ctx: Context,
        agentId: string,
        input: WorkflowLaunchInput,
        id: string,
    ): Promise<WorkflowLaunchRequest> {
        const script =
            "script" in input
                ? input.script
                : await this.#readScript(ctx, agentId, input.scriptPath);
        if (script.length > MAX_WORKFLOW_SCRIPT_LENGTH) {
            throw new Error(
                `Workflow scripts are limited to ${String(MAX_WORKFLOW_SCRIPT_LENGTH)} characters.`,
            );
        }
        const named = input.name?.trim();
        const workflow =
            named !== undefined && named.length > 0
                ? named.slice(0, MAX_WORKFLOW_NAME_LENGTH)
                : "script" in input
                  ? "dynamic-workflow"
                  : workflowNameFromScriptPath(input.scriptPath);
        const described = input.description?.trim();
        return {
            id,
            workflow,
            description: (described !== undefined && described.length > 0
                ? described
                : `Run ${workflow}`
            ).slice(0, MAX_WORKFLOW_DESCRIPTION_LENGTH),
            script: script.replace(/\r\n?/g, "\n"),
            ...(input.args === undefined ? {} : { args: structuredClone(input.args) }),
            ...(input.resumeFromRunId === undefined
                ? {}
                : { resumeFromRunId: input.resumeFromRunId }),
        };
    }

    async #readScript(ctx: Context, agentId: string, scriptPath: string): Promise<string> {
        const compute = await this.#compute?.resolve(ctx, agentId);
        if (compute === undefined) {
            throw new Error("This agent cannot read workflow scripts from disk.");
        }
        const resolved = resolveComputePath(scriptPath, compute.cwd, compute.fs.home);
        return await compute.fs.readFile(computePermissionsForContext(ctx), resolved);
    }

    /** What a paused run was launched with, so resuming does not need the model to say it again. */
    async #storedRequest(
        ctx: Context,
        agentId: string,
        run: WorkflowRun,
    ): Promise<WorkflowLaunchRequest> {
        const request = await readWorkflowLaunch(ctx, agentId, run.id);
        if (request === undefined) {
            throw new Error(`Workflow run "${run.id}" no longer has its script.`);
        }
        return request;
    }

    /**
     * Put a run on the module's own lifetime. A workflow outlives the turn that asked for it, so it
     * cannot be owned by that turn's context: the tool call returns, and the run keeps going.
     */
    #start(
        agentId: string,
        request: WorkflowLaunchRequest,
        resumeFromRunId: string | undefined,
    ): void {
        const controller = new AbortController();
        const finished = this.#execute(
            this.#runContext,
            agentId,
            request,
            controller,
            resumeFromRunId,
        )
            .catch(() => undefined)
            .finally(() => {
                this.#live.delete(request.id);
            });
        this.#live.set(request.id, { controller, finished });
    }

    /** Waits for the runs this module started. Closing the host and tests both need it. */
    async whenRunsSettle(): Promise<void> {
        while (this.#live.size > 0) {
            await Promise.allSettled([...this.#live.values()].map((run) => run.finished));
        }
    }

    async #execute(
        ctx: Context,
        agentId: string,
        request: WorkflowLaunchRequest,
        controller: AbortController,
        resumeFromRunId: string | undefined,
    ): Promise<void> {
        const reuseFrom = resumeFromRunId ?? request.resumeFromRunId;
        const [resumeCheckpoint, resumeAgentCalls] =
            reuseFrom === undefined
                ? [undefined, []]
                : await Promise.all([
                      readWorkflowCheckpoint(ctx, agentId, reuseFrom),
                      readWorkflowAgentCalls(ctx, agentId, reuseFrom).then((calls) =>
                          calls.map((call) =>
                              call === undefined
                                  ? undefined
                                  : { output: call.output, signature: call.signature },
                          ),
                      ),
                  ]);
        const runner = new WorkflowScriptRunner({
            args: request.args ?? null,
            startAgent: (start, signal) =>
                this.#startAgent(ctx, agentId, request.id, start, signal),
            onAgentCall: () => {
                void this.#note(ctx, agentId, request.id, { agentStarted: true });
            },
            onAgentResult: async (callIndex, result) => {
                await this.#rememberAgentResult(ctx, agentId, request.id, callIndex, result);
            },
            onCheckpoint: async (checkpoint) => {
                await ctx.inTx(async (txCtx) => {
                    await writeWorkflowCheckpoint(txCtx, agentId, request.id, checkpoint);
                });
            },
            onLog: (message) => {
                void this.#note(ctx, agentId, request.id, { log: message });
            },
            onPhase: (phase) => {
                void this.#note(ctx, agentId, request.id, { phase });
            },
            resumeAgentCalls,
            ...(resumeCheckpoint === undefined ? {} : { resumeCheckpoint }),
            signal: controller.signal,
        });

        try {
            const output = await runner.run(request.script);
            await this.#finish(ctx, agentId, request.id, {
                output: serializeWorkflowValue(output).slice(0, MAX_WORKFLOW_OUTPUT_CHARACTERS),
            });
        } catch (error: unknown) {
            if (controller.signal.aborted) return;
            await this.#finish(ctx, agentId, request.id, {
                error: describeError(error).slice(0, MAX_WORKFLOW_ERROR_LENGTH),
            });
        }
    }

    /**
     * Start one collaborator for one agent call and wait for what it says.
     *
     * The wait is registered before the collaborator exists, because a fast agent can settle
     * before this call would otherwise have somewhere to put the answer.
     */
    async #startAgent(
        ctx: Context,
        agentId: string,
        runId: string,
        start: WorkflowAgentStart,
        signal: AbortSignal,
    ): Promise<string> {
        const collaboratorId = this.#newCollaboratorId();
        const answer = new Promise<string>((resolve, reject) => {
            this.#waiters.set(collaboratorId, { resolve, reject });
        });
        try {
            await ctx.inTx(async (txCtx) => {
                await writeWorkflowAgentCall(txCtx, agentId, {
                    runId,
                    callIndex: start.callIndex,
                    collaboratorId,
                    signature: start.signature,
                });
                await this.#collaboration.createAgent(
                    txCtx,
                    agentId,
                    {
                        title: start.title,
                        model: start.model,
                        effort: start.effort,
                        ...(start.provider === undefined ? {} : { provider: start.provider }),
                        ...(start.serviceTier === undefined
                            ? {}
                            : { serviceTier: start.serviceTier }),
                        text: start.prompt,
                    },
                    collaboratorId,
                    {
                        // The workflow reads this answer itself, so reporting it into the chat
                        // would say the same thing twice — once per agent.
                        reportToCreator: false,
                        metadata: { workflow: { runId, callIndex: start.callIndex } },
                    },
                );
            });
            return await raceWithLifetime(answer, signal);
        } finally {
            this.#waiters.delete(collaboratorId);
        }
    }

    /**
     * Keep what the call actually produced. The settlement stored what the agent said; this is
     * what the script received, which for a call asking for JSON is the parsed value.
     */
    async #rememberAgentResult(
        ctx: Context,
        agentId: string,
        runId: string,
        callIndex: number,
        result: WorkflowAgentResult,
    ): Promise<void> {
        await ctx.inTx(async (txCtx) => {
            await writeWorkflowAgentCallOutput(txCtx, agentId, runId, callIndex, result);
        });
    }

    /** Move a run along: another agent started, another note, another phase. */
    async #note(
        ctx: Context,
        agentId: string,
        runId: string,
        change: { readonly agentStarted?: boolean; readonly log?: string; readonly phase?: string },
    ): Promise<void> {
        try {
            await ctx.inTx(async (txCtx) => {
                const run = await readWorkflowRun(txCtx, agentId, runId);
                if (run === undefined || isWorkflowTerminalStatus(run.status)) return;
                const line =
                    change.log === undefined
                        ? undefined
                        : change.log.replace(/\r\n?/g, "\n").slice(0, MAX_WORKFLOW_LOG_LINE_LENGTH);
                if (line !== undefined) {
                    await appendWorkflowLogs(txCtx, agentId, runId, [line]);
                }
                const logs = line === undefined ? run.logs : [...run.logs, line];
                const next: WorkflowRun = {
                    ...run,
                    updatedAt: this.#now(),
                    agentCount: run.agentCount + (change.agentStarted === true ? 1 : 0),
                    logs: logs.slice(-MAX_WORKFLOW_LOG_LINES),
                    logsTruncated: run.logsTruncated || logs.length > MAX_WORKFLOW_LOG_LINES,
                    ...(change.phase === undefined
                        ? {}
                        : { phase: change.phase.slice(0, MAX_WORKFLOW_NAME_LENGTH) }),
                };
                await this.#store(txCtx, next);
                await this.#publish(txCtx, "workflow_updated", next);
            });
        } catch (error: unknown) {
            // Progress is worth recording, never worth failing a running workflow for.
            ctx.log.warn("Failed to record workflow progress.", { runId }, error);
        }
    }

    async #finish(
        ctx: Context,
        agentId: string,
        runId: string,
        outcome: { readonly output: string } | { readonly error: string },
    ): Promise<void> {
        await ctx.inTx(async (txCtx) => {
            const run = await readWorkflowRun(txCtx, agentId, runId);
            if (run === undefined || isWorkflowTerminalStatus(run.status)) return;
            const at = this.#now();
            const finished: WorkflowRun =
                "output" in outcome
                    ? {
                          ...baseOf(run),
                          status: "completed",
                          finishedAt: at,
                          updatedAt: at,
                          output: outcome.output,
                      }
                    : {
                          ...baseOf(run),
                          status: "failed",
                          finishedAt: at,
                          updatedAt: at,
                          error: outcome.error,
                      };
            await this.#store(txCtx, finished);
            await this.#publish(txCtx, "workflow_finished", finished);
        });
    }

    async #require(ctx: Context, agentId: string, id: string): Promise<WorkflowRun> {
        if (!Value.Check(workflowAgentIdSchema, agentId) || !Value.Check(workflowIdSchema, id)) {
            throw new Error("The workflow identities are not valid.");
        }
        const run = await readWorkflowRun(ctx, agentId, id);
        if (run === undefined) throw new Error(`Workflow run "${id}" was not found.`);
        return run;
    }

    async #store(ctx: Context, run: WorkflowRun): Promise<void> {
        await writeWorkflowRun(ctx, run);
    }

    /**
     * Tell whoever is watching, once the change is durable. A watcher failing is a watcher's
     * problem: the run has already moved and cannot be moved back.
     */
    async #publish(ctx: Context, type: WorkflowEvent["type"], run: WorkflowRun): Promise<void> {
        const listener = this.#options.listener;
        if (listener === undefined) return;
        const event: WorkflowEvent = {
            type,
            agentId: run.agentId,
            eventId: this.#options.eventIdFactory?.() ?? createId(),
            at: this.#now(),
            run: structuredClone(run),
        };
        await listener.onEventTransactional?.(ctx, event);
        afterCommit(ctx, async (postCommitCtx) => {
            try {
                await listener.onEvent?.(postCommitCtx, event);
            } catch (error: unknown) {
                try {
                    await this.#options.onPostCommitError?.(
                        postCommitCtx,
                        event,
                        boundedReason(describeError(error)),
                    );
                } catch {
                    // An observer cannot turn a committed run into a failure.
                }
            }
        });
    }

    #bound(text: string): string {
        return text.length <= this.#maxOutputCharacters
            ? text
            : `${text.slice(0, this.#maxOutputCharacters - 1)}…`;
    }

    #newCollaboratorId(): string {
        return this.#options.collaboratorIdFactory?.() ?? createId();
    }

    #now(): number {
        return this.#options.clock?.() ?? Date.now();
    }

    #assertEnabled(): void {
        if (!this.#enabled) throw new Error("Workflows are turned off for this agent.");
    }
}

/** Where a workflow collaborator keeps the last thing it said, until its run ends. */
const LAST_TEXT_KEY = "lastText";

/** Where a workflow collaborator keeps why it stopped answering, until its run ends. */
const LAST_ERROR_KEY = "lastError";

/** Whether this agent is one a workflow started, which is written in its own metadata. */
function isWorkflowCollaborator(metadata: AgentMetadata | undefined): boolean {
    const workflow = metadata?.["workflow"];
    return workflow !== null && typeof workflow === "object" && !Array.isArray(workflow);
}

/**
 * What every run carries whatever its status is. A run is rebuilt from this rather than spread
 * over, so moving to a new status cannot leave the previous one's outcome attached to it.
 */
function baseOf(run: WorkflowRun): Omit<WorkflowRunningRun, "status"> {
    return {
        id: run.id,
        agentId: run.agentId,
        workflow: run.workflow,
        description: run.description,
        agentCount: run.agentCount,
        logs: [...run.logs],
        logsTruncated: run.logsTruncated,
        createdAt: run.createdAt,
        updatedAt: run.updatedAt,
        startedAt: run.startedAt,
        ...(run.phase === undefined ? {} : { phase: run.phase }),
    };
}

/** Wait, unless whoever asked stops caring first. */
async function raceWithLifetime<Value>(
    waiting: Promise<Value>,
    signal: AbortSignal | undefined,
): Promise<Value> {
    if (signal === undefined) return await waiting;
    const stopped = new Error("The wait was cancelled; the workflow is still running.");
    if (signal.aborted) throw stopped;
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
        onAbort = () => {
            reject(stopped);
        };
        signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
        return await Promise.race([waiting, aborted]);
    } finally {
        if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
    }
}

function workflowNameFromScriptPath(path: string): string {
    const leaf = path.split(/[\\/]/u).at(-1)?.replace(/\.py$/iu, "") ?? "";
    return leaf.length > 0 && leaf.length <= MAX_WORKFLOW_NAME_LENGTH ? leaf : "dynamic-workflow";
}

function describeError(error: unknown): string {
    if (error instanceof Error && error.message.length > 0) return error.message;
    const text = String(error);
    return text.length > 0 ? text : "The workflow stopped for an unknown reason.";
}

function boundedReason(message: string): string {
    const normalized = message.replace(/\r\n?/g, "\n").replaceAll("\0", "�");
    return normalized.length <= MAX_WORKFLOW_POST_COMMIT_ERROR_LENGTH
        ? normalized
        : `${normalized.slice(0, MAX_WORKFLOW_POST_COMMIT_ERROR_LENGTH - 1)}…`;
}

/** Arguments travel to the script as JSON, so they have to fit in the bound the schema promises. */
function assertWorkflowArgsBounds(args: unknown): void {
    if (args === undefined) return;
    if (!Value.Check(workflowArgsSchema, args)) {
        throw new Error("The workflow arguments are not bounded JSON.");
    }
    const encoded = JSON.stringify(args);
    if (
        encoded === undefined ||
        new TextEncoder().encode(encoded).byteLength > MAX_WORKFLOW_ARGS_BYTES
    ) {
        throw new Error(
            `Workflow arguments are limited to ${String(MAX_WORKFLOW_ARGS_BYTES)} bytes.`,
        );
    }
}
