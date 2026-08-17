import { sql } from "drizzle-orm";
import {
    agentDatabaseRun,
    type AgentModule,
    type AgentModuleHooks,
    type AgentModuleMigration,
    type AgentModuleScope,
    type AnyAgentTool,
} from "@slopus/happy-agent-base";
import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { afterCommit, type Context } from "@steve.kite/stdlib";

import {
    MAX_WORKFLOW_CURSOR,
    MAX_WORKFLOW_ARGS_BYTES,
    MAX_WORKFLOW_ID_LENGTH,
    MAX_WORKFLOW_LOG_LINE_LENGTH,
    MAX_WORKFLOW_LOG_LINES,
    MAX_WORKFLOW_NAME_LENGTH,
    MAX_WORKFLOW_OUTPUT_CHARACTERS,
    MAX_WORKFLOW_PAGE_SIZE,
    workflowAgentIdSchema,
    workflowArgsSchema,
    workflowIdSchema,
    workflowLegacyStatusFor,
    workflowLaunchInputSchema,
    workflowLaunchToolInputSchema,
    workflowLogQuerySchema,
    workflowMutationInputSchema,
    workflowMutationResultSchema,
    workflowMutationToolInputSchema,
    workflowPageQuerySchema,
    workflowRunSchema,
    workflowTimestampSchema,
    type WorkflowAgentId,
    type WorkflowLaunchInput,
    type WorkflowLaunchRequest,
    type WorkflowLaunchToolInput,
    type WorkflowLogPage,
    type WorkflowLogQuery,
    type WorkflowMutationInput,
    type WorkflowMutationRequest,
    type WorkflowMutationResult,
    type WorkflowMutationToolInput,
    type WorkflowObservedRun,
    type WorkflowPage,
    type WorkflowPageQuery,
    type WorkflowRun,
} from "./Workflow.js";
import {
    MAX_WORKFLOW_POST_COMMIT_ERROR_LENGTH,
    workflowEventIdSchema,
    workflowEventSchema,
    workflowModuleListenerSchema,
    workflowPostCommitErrorSchema,
    type WorkflowEvent,
} from "./WorkflowEvent.js";
import {
    assertWorkflowLogPage,
    assertWorkflowMutationResult,
    assertWorkflowObservedRun,
    assertWorkflowPage,
    assertWorkflowRun,
    workflowRuntimeSchema,
    type WorkflowRuntime,
} from "./WorkflowStore.js";
import {
    WORKFLOWS_MIGRATION_KEY,
    WORKFLOW_LOGS_TABLE,
    WORKFLOW_PROOFS_TABLE,
    WORKFLOW_RECEIPTS_TABLE,
    WORKFLOW_RUNS_TABLE,
    createWorkflowDatabase,
    type WorkflowDatabase,
} from "./WorkflowDatabase.js";
import { cancelWorkflowTool } from "./tools/cancel_workflow.js";
import { listWorkflowsTool } from "./tools/list_workflows.js";
import { resumeWorkflowTool } from "./tools/resume_workflow.js";
import { runWorkflowTool } from "./tools/run_workflow.js";
import { waitWorkflowTool } from "./tools/wait_workflow.js";
import { workflowLogsTool } from "./tools/workflow_logs.js";
import { workflowStatusTool } from "./tools/workflow_status.js";

const maxOutputSchema = Type.Integer({
    minimum: 256,
    maximum: MAX_WORKFLOW_OUTPUT_CHARACTERS,
});
const workflowModuleOptionsSchema = Type.Object(
    {
        enabled: Type.Optional(Type.Boolean()),
        runtime: workflowRuntimeSchema,
        idFactory: Type.Optional(
            Type.Function(
                [
                    Type.Unsafe<Context>(Type.Object({}, { additionalProperties: false })),
                    workflowAgentIdSchema,
                ],
                Type.Union([workflowIdSchema, Type.Promise(workflowIdSchema)]),
            ),
        ),
        eventIdFactory: Type.Optional(
            Type.Function(
                [
                    Type.Unsafe<Context>(Type.Object({}, { additionalProperties: false })),
                    workflowAgentIdSchema,
                ],
                Type.Union([workflowEventIdSchema, Type.Promise(workflowEventIdSchema)]),
            ),
        ),
        clock: Type.Optional(Type.Function([], workflowTimestampSchema)),
        listener: Type.Optional(workflowModuleListenerSchema),
        maxPageSize: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_WORKFLOW_PAGE_SIZE })),
        maxLogLines: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_WORKFLOW_LOG_LINES })),
        maxOutputCharacters: Type.Optional(maxOutputSchema),
        onPostCommitError: Type.Optional(
            Type.Function(
                [
                    Type.Unsafe<Context>(Type.Object({}, { additionalProperties: false })),
                    workflowEventSchema,
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
const MAX_WORKFLOW_STATUS_TEXT_LENGTH = "unavailable".length;
const PAGE_CURSOR_SUFFIX = `\nprev:${MAX_WORKFLOW_CURSOR}\nnext:${MAX_WORKFLOW_CURSOR}`;
const LOG_CURSOR_SUFFIX = `\nprev:${MAX_WORKFLOW_CURSOR}\nnext:${MAX_WORKFLOW_CURSOR}`;
const DROP_WORKFLOW_REPLAY_TABLES_MIGRATION_KEY = "002-workflows-drop-replay-evidence";

export class WorkflowsModule implements AgentModule {
    readonly name = "workflows";
    readonly #store: WorkflowDatabase;
    readonly #enabled: boolean;
    readonly #idFactory: NonNullable<WorkflowModuleOptions["idFactory"]>;
    readonly #eventIdFactory: NonNullable<WorkflowModuleOptions["eventIdFactory"]>;
    readonly #clock: NonNullable<WorkflowModuleOptions["clock"]>;
    readonly #optionsOwner: WorkflowModuleOptions;
    readonly #listener: WorkflowModuleOptions["listener"];
    readonly #maxPageSize: number;
    readonly #maxLogLines: number;
    readonly #maxOutputCharacters: number;
    readonly #maxModelRows: number;
    readonly #maxModelLogLines: number;
    readonly #onPostCommitError: WorkflowModuleOptions["onPostCommitError"];

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
    ];

    constructor(options: WorkflowModuleOptions) {
        if (!Value.Check(workflowModuleOptionsSchema, options)) {
            throw new Error("Workflow module options are invalid.");
        }
        this.#store = createWorkflowDatabase(options.runtime as WorkflowRuntime);
        this.#enabled = options.enabled ?? true;
        this.#idFactory = options.idFactory ?? (() => globalThis.crypto.randomUUID());
        this.#eventIdFactory = options.eventIdFactory ?? (() => globalThis.crypto.randomUUID());
        this.#clock = options.clock ?? Date.now;
        this.#optionsOwner = options;
        this.#listener = options.listener;
        this.#maxPageSize = options.maxPageSize ?? DEFAULT_PAGE_SIZE;
        this.#maxLogLines = options.maxLogLines ?? DEFAULT_MAX_LOG_LINES;
        this.#maxOutputCharacters = options.maxOutputCharacters ?? DEFAULT_MAX_OUTPUT;
        const maxRunRowCharacters =
            MAX_WORKFLOW_ID_LENGTH +
            2 +
            MAX_WORKFLOW_NAME_LENGTH +
            2 +
            MAX_WORKFLOW_STATUS_TEXT_LENGTH +
            1;
        this.#maxModelRows = Math.max(
            1,
            Math.floor(
                (this.#maxOutputCharacters - PAGE_CURSOR_SUFFIX.length + 1) /
                    (maxRunRowCharacters + 1),
            ),
        );
        const maxLogHeaderCharacters = MAX_WORKFLOW_ID_LENGTH + 1;
        this.#maxModelLogLines = Math.max(
            1,
            Math.floor(
                (this.#maxOutputCharacters -
                    maxLogHeaderCharacters -
                    LOG_CURSOR_SUFFIX.length +
                    1) /
                    (MAX_WORKFLOW_LOG_LINE_LENGTH + 1),
            ),
        );
        this.#onPostCommitError = options.onPostCommitError;
        this.#now();
    }

    readonly #hooks: AgentModuleHooks = {
        tools: (_ctx: Context, scope: AgentModuleScope): readonly AnyAgentTool[] =>
            this.#enabled
                ? [
                      runWorkflowTool(this, scope.agent.id),
                      listWorkflowsTool(this, scope.agent.id),
                      workflowStatusTool(this, scope.agent.id),
                      cancelWorkflowTool(this, scope.agent.id),
                      resumeWorkflowTool(this, scope.agent.id),
                      waitWorkflowTool(this, scope.agent.id),
                      workflowLogsTool(this, scope.agent.id),
                  ]
                : [],
    };

    readonly beforeStart = (): AgentModuleHooks => this.#hooks;

    async launch(
        ctx: Context,
        agentId: string,
        input: WorkflowLaunchInput,
    ): Promise<WorkflowObservedRun> {
        this.#assertEnabled();
        this.#assertAgentId(agentId);
        this.#assertInput(workflowLaunchInputSchema, input, "workflow launch");
        assertWorkflowLaunchBounds(input);
        const operationId = input.operationId ?? (await this.#newOperationId(ctx, agentId));
        return await this.#launch(ctx, agentId, normalizeLaunchInput(input, operationId));
    }

    async launchForTool(
        ctx: Context,
        agentId: string,
        input: WorkflowLaunchToolInput,
        callId: string,
    ): Promise<WorkflowObservedRun> {
        this.#assertEnabled();
        this.#assertAgentId(agentId);
        this.#assertInput(workflowLaunchToolInputSchema, input, "workflow launch tool");
        this.#assertId(callId);
        assertWorkflowLaunchBounds(input);
        return await this.#launch(ctx, agentId, normalizeLaunchInput(input, callId));
    }

    async status(
        ctx: Context,
        agentId: string,
        id: string,
    ): Promise<WorkflowObservedRun | undefined> {
        this.#assertEnabled();
        this.#assertAgentId(agentId);
        this.#assertId(id);
        const run = await this.#getStoreRun(ctx, agentId, id);
        if (run === undefined) return undefined;
        assertRunOwner(run, agentId, "Workflow store returned a run for another agent.");
        assertRunId(run, id, "Workflow store returned the wrong run.");
        return structuredClone(run);
    }

    async list(
        ctx: Context,
        agentId: string,
        query: WorkflowPageQuery = {},
    ): Promise<WorkflowPage> {
        this.#assertEnabled();
        this.#assertAgentId(agentId);
        this.#assertInput(workflowPageQuerySchema, query, "workflow page query");
        const requestedLimit = query.limit ?? this.#maxPageSize;
        if (requestedLimit > this.#maxPageSize) {
            throw new Error("Workflow page exceeds configured bound.");
        }
        const limit = Math.min(requestedLimit, this.#maxModelRows);
        const page = await this.#listStorePage(ctx, agentId, { ...query, limit });
        assertWorkflowPageOwner(page, agentId);
        if (page.runs.length > limit) throw new Error("Workflow store returned too many runs.");
        assertWorkflowPageRecords(page, query);
        assertExactOffsetPage(page, query, limit);
        this.formatPageForModel(page);
        return structuredClone(page);
    }

    async cancel(
        ctx: Context,
        agentId: string,
        input: WorkflowMutationInput,
    ): Promise<WorkflowMutationResult> {
        this.#assertEnabled();
        return await this.#publicMutation(ctx, agentId, input, "cancel");
    }

    async cancelForTool(
        ctx: Context,
        agentId: string,
        input: WorkflowMutationToolInput,
        callId: string,
    ): Promise<WorkflowMutationResult> {
        this.#assertEnabled();
        return await this.#toolMutation(ctx, agentId, input, callId, "cancel");
    }

    async resume(
        ctx: Context,
        agentId: string,
        input: WorkflowMutationInput,
    ): Promise<WorkflowMutationResult> {
        this.#assertEnabled();
        return await this.#publicMutation(ctx, agentId, input, "resume");
    }

    async resumeForTool(
        ctx: Context,
        agentId: string,
        input: WorkflowMutationToolInput,
        callId: string,
    ): Promise<WorkflowMutationResult> {
        this.#assertEnabled();
        return await this.#toolMutation(ctx, agentId, input, callId, "resume");
    }

    async wait(ctx: Context, agentId: string, id: string): Promise<WorkflowObservedRun> {
        this.#assertEnabled();
        return await this.#wait(ctx, agentId, id);
    }

    async waitForTool(ctx: Context, agentId: string, id: string): Promise<WorkflowObservedRun> {
        this.#assertEnabled();
        return await this.#wait(ctx, agentId, id);
    }

    async #wait(ctx: Context, agentId: string, id: string): Promise<WorkflowObservedRun> {
        this.#assertAgentId(agentId);
        this.#assertId(id);
        const run = await this.#waitStoreRun(ctx, agentId, id);
        assertRunOwner(run, agentId, "Workflow store returned a run for another agent.");
        assertRunId(run, id, "Workflow store returned the wrong run.");
        if (!isWorkflowTerminalStatus(run.status)) {
            throw new Error("Workflow wait returned before a terminal or unavailable status.");
        }
        const persisted = await ctx.inTx(async (txCtx) => {
            await this.#saveStoreRun(txCtx, run);
            const persisted = await this.#getStoreRun(txCtx, agentId, id);
            if (persisted === undefined || !sameWorkflowRunObject(persisted, run)) {
                throw new Error("Workflow wait result was not persisted.");
            }
            return persisted;
        });
        return structuredClone(persisted);
    }

    async logs(ctx: Context, agentId: string, query: WorkflowLogQuery): Promise<WorkflowLogPage> {
        this.#assertEnabled();
        this.#assertAgentId(agentId);
        this.#assertInput(workflowLogQuerySchema, query, "workflow log query");
        const requestedLimit = Math.min(query.limit ?? this.#maxLogLines, this.#maxLogLines);
        const limit = Math.min(requestedLimit, this.#maxModelLogLines);
        const page = await this.#logsStorePage(ctx, agentId, { ...query, limit });
        if (page.id !== query.id || page.lines.length > limit || page.agentId !== agentId) {
            throw new Error("Workflow store returned logs outside the requested bound.");
        }
        assertExactLogPage(page, query, limit);
        this.formatLogsForModel(page);
        return structuredClone(page);
    }

    formatPageForModel(page: WorkflowPage): string {
        assertWorkflowPage(page);
        if (page.nextCursor !== undefined && page.runs.length === 0) {
            throw new Error("Workflow page with a next cursor must expose a run.");
        }
        const text = page.runs.map(formatRunRow).join("\n") || "No workflow runs.";
        const output = `${text}${formatCursorSuffix(page.previousCursor, page.nextCursor)}`;
        if (output.length > this.#maxOutputCharacters) {
            throw new Error("Workflow page exceeded the model output bound.");
        }
        return output;
    }

    formatRunForModel(run: WorkflowRun): string {
        assertWorkflowRun(run);
        const logs = run.logs ?? [];
        const logOutputReserve =
            `\nlogs (${MAX_WORKFLOW_LOG_LINES} accumulated):`.length +
            "\nlogs_truncated: true".length;
        const scalarTruncationReserve = "\noutput_truncated: true\nerror_truncated: true".length;
        const pieces = [
            `${run.id}: ${run.workflow}`,
            `status: ${run.status}`,
            `legacy_status: ${run.legacyStatus ?? workflowLegacyStatusFor(run.status)}`,
            `agent_count: ${run.agentCount ?? 0}`,
        ];
        if (
            pieces.join("\n").length + logOutputReserve + scalarTruncationReserve >
            this.#maxOutputCharacters
        ) {
            return formatCompactRunForModel(run, this.#maxOutputCharacters);
        }
        for (const [label, value] of [
            ["output", "output" in run ? run.output : undefined],
            ["error", "error" in run ? run.error : undefined],
        ] as const) {
            if (value === undefined) continue;
            const prefix = `${label}: `;
            const available =
                this.#maxOutputCharacters -
                pieces.join("\n").length -
                1 -
                prefix.length -
                logOutputReserve -
                scalarTruncationReserve;
            if (available <= 0) {
                pieces.push(`${label}_truncated: true`);
                continue;
            }
            const text = value.slice(0, available);
            pieces.push(`${prefix}${text}`);
            if (text.length !== value.length) pieces.push(`${label}_truncated: true`);
        }
        let output = pieces.join("\n");
        const logHeader = `logs (${logs.length} accumulated):`;
        output += `\n${logHeader}`;
        let logsTruncated = run.logsTruncated === true;
        let renderedLogCount = 0;
        const truncationMarker = "\nlogs_truncated: true";
        for (const [index, log] of logs.entries()) {
            const prefix = `\n${index + 1}: `;
            const available = this.#maxOutputCharacters - output.length - truncationMarker.length;
            if (available <= prefix.length) {
                logsTruncated = true;
                break;
            }
            const textBudget = available - prefix.length;
            const text =
                log.length <= textBudget
                    ? log
                    : textBudget <= 1
                      ? "…"
                      : `${log.slice(0, textBudget - 1)}…`;
            if (text.length !== log.length) logsTruncated = true;
            output += `${prefix}${text}`;
            renderedLogCount += 1;
            if (logsTruncated) break;
        }
        if (renderedLogCount < logs.length) logsTruncated = true;
        if (logsTruncated) {
            output += truncationMarker;
        }
        if (output.length > this.#maxOutputCharacters) {
            throw new Error("Workflow status exceeded the model output bound.");
        }
        return output;
    }

    #assertEnabled(): void {
        if (!this.#enabled) {
            throw new Error("Workflows are disabled by configuration.");
        }
    }

    formatLogsForModel(page: WorkflowLogPage): string {
        assertWorkflowLogPage(page);
        if (page.nextCursor !== undefined && page.lines.length === 0) {
            throw new Error("Workflow log page with a next cursor must expose a log line.");
        }
        const suffix = formatCursorSuffix(page.previousCursor, page.nextCursor);
        const fixedCharacters = page.id.length + (page.lines.length > 0 ? 1 : 0) + suffix.length;
        const available = this.#maxOutputCharacters - fixedCharacters;
        const lineBudget = Math.floor(
            (available - Math.max(0, page.lines.length - 1)) / Math.max(1, page.lines.length),
        );
        if (page.lines.length > 0 && lineBudget < 1) {
            throw new Error("Workflow logs exceeded the model output bound.");
        }
        const lines = page.lines.map(({ text }) =>
            text.length <= lineBudget
                ? text
                : lineBudget === 1
                  ? text.slice(0, 1)
                  : `${text.slice(0, lineBudget - 1)}…`,
        );
        const output = [page.id, ...lines].join("\n") + suffix;
        if (output.length > this.#maxOutputCharacters) {
            throw new Error("Workflow logs exceeded the model output bound.");
        }
        return output;
    }

    async #launch(
        ctx: Context,
        agentId: string,
        request: WorkflowLaunchRequest,
    ): Promise<WorkflowObservedRun> {
        const existing = await this.#getStoreRun(ctx, agentId, request.operationId);
        if (existing !== undefined) {
            throw new Error(`Workflow run "${request.operationId}" already exists.`);
        }
        const launched = await this.#launchStoreRun(ctx, agentId, structuredClone(request));
        assertRunOwner(launched, agentId, "Workflow runtime returned a run for another agent.");
        assertLaunchResult(launched, request);
        const persisted = await ctx.inTx(async (txCtx) => {
            await this.#saveStoreRun(txCtx, launched);
            const persisted = await this.#getStoreRun(txCtx, agentId, request.operationId);
            if (persisted === undefined) {
                throw new Error("Workflow launch result was not persisted.");
            }
            assertRunOwner(
                persisted,
                agentId,
                "Workflow launch persisted a run for another agent.",
            );
            assertLaunchResult(persisted, request);
            if (!sameWorkflowRunObject(launched, persisted)) {
                throw new Error("Workflow launch result differs from storage.");
            }
            await this.#createEvent(txCtx, "workflow_started", agentId, persisted);
            return persisted;
        });
        assertRunOwner(persisted, agentId, "Workflow transaction returned another agent's run.");
        assertRunId(persisted, request.operationId, "Workflow transaction returned the wrong run.");
        return structuredClone(persisted);
    }

    async #publicMutation(
        ctx: Context,
        agentId: string,
        input: WorkflowMutationInput,
        operation: "cancel" | "resume",
    ): Promise<WorkflowMutationResult> {
        this.#assertAgentId(agentId);
        this.#assertInput(workflowMutationInputSchema, input, `workflow ${operation}`);
        const operationId = input.operationId ?? (await this.#newOperationId(ctx, agentId));
        return await this.#mutate(ctx, agentId, { id: input.id, operationId }, operation);
    }

    async #toolMutation(
        ctx: Context,
        agentId: string,
        input: WorkflowMutationToolInput,
        callId: string,
        operation: "cancel" | "resume",
    ): Promise<WorkflowMutationResult> {
        this.#assertAgentId(agentId);
        this.#assertInput(workflowMutationToolInputSchema, input, `workflow ${operation} tool`);
        this.#assertId(callId);
        return await this.#mutate(ctx, agentId, { id: input.id, operationId: callId }, operation);
    }

    async #mutate(
        ctx: Context,
        agentId: string,
        request: WorkflowMutationRequest,
        operation: "cancel" | "resume",
    ): Promise<WorkflowMutationResult> {
        const current = await this.#getStoreRun(ctx, agentId, request.id);
        if (current === undefined) throw new Error("Workflow mutation target was not found.");
        assertRunOwner(current, agentId, "Workflow store returned another agent's run.");
        assertRunId(current, request.id, "Workflow store returned the wrong run.");
        if (!workflowMutationInvokesRuntime(current, operation)) {
            return {
                agentId,
                operationId: request.operationId,
                run: structuredClone(current),
                changed: false,
            };
        }
        const mutation = await this.#mutateStoreRun(
            ctx,
            agentId,
            structuredClone(request),
            operation,
        );
        assertMutationOwner(mutation, agentId, request);
        const changed = assertMutationTransition(current, mutation.run, request.id, operation);
        if (mutation.changed !== changed) {
            throw new Error("Workflow runtime result did not match the stored transition.");
        }
        return await ctx.inTx(async (txCtx) => {
            await this.#saveStoreRun(txCtx, mutation.run);
            if (changed) {
                await this.#createEvent(
                    txCtx,
                    operation === "cancel" ? "workflow_cancelled" : "workflow_updated",
                    agentId,
                    mutation.run,
                );
            }
            return {
                agentId,
                operationId: request.operationId,
                run: structuredClone(mutation.run),
                changed,
            };
        });
    }

    async #launchStoreRun(
        ctx: Context,
        agentId: string,
        request: WorkflowLaunchRequest,
    ): Promise<WorkflowObservedRun> {
        const raw: unknown = Reflect.apply(this.#store.launch, this.#store, [
            ctx,
            agentId,
            request,
        ]);
        const resolved = await workflowStorePromise(raw, "launch");
        assertWorkflowRun(resolved);
        return normalizeWorkflowRun(resolved);
    }

    async #getStoreRun(
        ctx: Context,
        agentId: string,
        id: string,
    ): Promise<WorkflowObservedRun | undefined> {
        const raw: unknown = Reflect.apply(this.#store.get, this.#store, [ctx, agentId, id]);
        const resolved = await workflowStorePromise(raw, "get");
        if (resolved === undefined) return undefined;
        assertWorkflowRun(resolved);
        return normalizeWorkflowRun(resolved);
    }

    async #listStorePage(
        ctx: Context,
        agentId: string,
        query: WorkflowPageQuery,
    ): Promise<WorkflowPage> {
        const raw: unknown = Reflect.apply(this.#store.list, this.#store, [ctx, agentId, query]);
        const resolved = await workflowStorePromise(raw, "list");
        assertWorkflowPage(resolved);
        return {
            ...resolved,
            runs: resolved.runs.map(normalizeWorkflowRun),
        };
    }

    async #mutateStoreRun(
        ctx: Context,
        agentId: string,
        request: WorkflowMutationRequest,
        operation: "cancel" | "resume",
    ): Promise<WorkflowMutationResult> {
        const method = operation === "cancel" ? this.#store.cancel : this.#store.resume;
        const raw: unknown = Reflect.apply(method, this.#store, [ctx, agentId, request]);
        const resolved = await workflowStorePromise(raw, operation);
        assertWorkflowMutationResult(resolved);
        return {
            ...resolved,
            run: normalizeWorkflowRun(resolved.run),
        };
    }

    async #waitStoreRun(ctx: Context, agentId: string, id: string): Promise<WorkflowObservedRun> {
        const raw: unknown = Reflect.apply(this.#store.wait, this.#store, [ctx, agentId, id]);
        const waiting = workflowStorePromise(raw, "wait");
        const resolved = await raceWorkflowWait(waiting, ctx.lifetime);
        assertWorkflowRun(resolved);
        return normalizeWorkflowRun(resolved);
    }

    async #saveStoreRun(ctx: Context, run: WorkflowRun): Promise<void> {
        const normalized = normalizeWorkflowRun(run);
        const raw: unknown = Reflect.apply(this.#store.save, this.#store, [ctx, normalized]);
        const resolved = await workflowStorePromise(raw, "save");
        if (resolved !== undefined) {
            throw new Error("Workflow save must resolve to undefined.");
        }
    }

    async #logsStorePage(
        ctx: Context,
        agentId: string,
        query: WorkflowLogQuery,
    ): Promise<WorkflowLogPage> {
        const raw: unknown = Reflect.apply(this.#store.logs, this.#store, [ctx, agentId, query]);
        const resolved = await workflowStorePromise(raw, "logs");
        assertWorkflowLogPage(resolved);
        return resolved;
    }

    async #newOperationId(ctx: Context, agentId: string): Promise<string> {
        const id = await workflowFactoryResult(
            Reflect.apply(this.#idFactory, this.#optionsOwner, [ctx, agentId]),
            "ID factory",
        );
        this.#assertId(id);
        return id;
    }

    async #createEvent(
        ctx: Context,
        type: WorkflowEvent["type"],
        agentId: string,
        run: WorkflowRun,
    ): Promise<WorkflowEvent> {
        const eventId = await workflowFactoryResult(
            Reflect.apply(this.#eventIdFactory, this.#optionsOwner, [ctx, agentId]),
            "event ID factory",
        );
        if (!Value.Check(workflowEventIdSchema, eventId)) {
            throw new Error("Workflow event ID factory returned an invalid ID.");
        }
        const event = { type, agentId, eventId, at: this.#now(), run: structuredClone(run) };
        if (!Value.Check(workflowEventSchema, event)) {
            throw new Error("Workflow module created an invalid event.");
        }
        const frozen = deepFreeze(structuredClone(event));
        const callback = this.#listener?.onEventTransactional;
        if (callback !== undefined) {
            await workflowVoidResult(
                callback.call(this.#listener, ctx, frozen),
                "transactional listener",
            );
        }
        afterCommit(ctx, (postCommitCtx) => this.#notifyPostCommit(postCommitCtx, frozen));
        return frozen;
    }

    async #notifyPostCommit(ctx: Context, event: WorkflowEvent): Promise<void> {
        try {
            const callback = this.#listener?.onEvent;
            if (callback !== undefined) {
                await workflowVoidResult(
                    callback.call(this.#listener, ctx, event),
                    "post-commit listener",
                );
            }
        } catch (error: unknown) {
            try {
                const reporter = this.#onPostCommitError;
                if (reporter !== undefined) {
                    await workflowVoidResult(
                        reporter.call(
                            this.#optionsOwner,
                            ctx,
                            event,
                            normalizePostCommitError(error),
                        ),
                        "post-commit error reporter",
                    );
                }
            } catch {
                // Advisory observers cannot turn committed workflow state into a failure.
            }
        }
    }

    #now(): number {
        const at: unknown = Reflect.apply(this.#clock, this.#optionsOwner, []);
        if (!Value.Check(workflowTimestampSchema, at)) {
            throw new Error("Workflow clock must return a non-negative integer.");
        }
        return at;
    }

    #assertId(id: unknown): asserts id is string {
        if (!Value.Check(workflowIdSchema, id)) throw new Error("Workflow ID is invalid.");
    }

    #assertAgentId(agentId: unknown): asserts agentId is WorkflowAgentId {
        if (!Value.Check(workflowAgentIdSchema, agentId)) {
            throw new Error("Workflow agent ID is invalid.");
        }
    }

    #assertInput<T extends object>(
        schema: TSchema,
        input: unknown,
        label: string,
    ): asserts input is T {
        if (!Value.Check(schema, input)) throw new Error(`Workflow ${label} is invalid.`);
    }
}

async function workflowStorePromise(value: unknown, label: string): Promise<unknown> {
    if (value === null || (typeof value !== "object" && typeof value !== "function")) {
        throw new Error(`Workflow ${label} must return a Promise.`);
    }
    const then = Reflect.get(value, "then");
    if (typeof then !== "function") throw new Error(`Workflow ${label} must return a Promise.`);
    return await (value as PromiseLike<unknown>);
}

async function raceWorkflowWait<T>(
    waiting: Promise<T>,
    signal: AbortSignal | undefined,
): Promise<T> {
    if (signal === undefined) return await waiting;
    if (signal.aborted) {
        throw new Error(
            "Workflow wait was cancelled; the workflow continues running in the background.",
        );
    }
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
        onAbort = () =>
            reject(
                new Error(
                    "Workflow wait was cancelled; the workflow continues running in the background.",
                ),
            );
        signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
        return await Promise.race([waiting, aborted]);
    } finally {
        if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
    }
}

async function workflowFactoryResult(value: unknown, label: string): Promise<unknown> {
    if (value === null || (typeof value !== "object" && typeof value !== "function")) return value;
    const then = Reflect.get(value, "then");
    return typeof then === "function" ? await (value as PromiseLike<unknown>) : value;
}

async function workflowVoidResult(value: unknown, label: string): Promise<void> {
    if (value === undefined) return;
    if (value === null || (typeof value !== "object" && typeof value !== "function")) {
        throw new Error(
            `Workflow ${label} must return undefined or a Promise resolving to undefined.`,
        );
    }
    const then = Reflect.get(value, "then");
    if (typeof then !== "function") {
        throw new Error(
            `Workflow ${label} must return undefined or a Promise resolving to undefined.`,
        );
    }
    if ((await (value as PromiseLike<unknown>)) !== undefined) {
        throw new Error(`Workflow ${label} must resolve to undefined.`);
    }
}

function normalizePostCommitError(error: unknown): string {
    let message = "Unknown Workflow observer error.";
    try {
        if (error instanceof Error && error.message.length > 0) message = error.message;
        else {
            const converted = String(error);
            if (converted.length > 0) message = converted;
        }
    } catch {
        // Keep the bounded fallback.
    }
    const normalized = message.replace(/\r\n?/g, "\n").replaceAll("\0", "�");
    return normalized.length <= MAX_WORKFLOW_POST_COMMIT_ERROR_LENGTH
        ? normalized
        : `${normalized.slice(0, MAX_WORKFLOW_POST_COMMIT_ERROR_LENGTH - 1)}…`;
}

function deepFreeze<T>(value: T): T {
    if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
        Object.freeze(value);
        for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    }
    return value;
}

function normalizeWorkflowInput(input: string | undefined): string | undefined {
    return input === undefined ? undefined : input.replace(/\r\n?/g, "\n");
}

function normalizeWorkflowScript(script: string): string {
    return script.replace(/\r\n?/g, "\n");
}

function assertWorkflowLaunchBounds(input: WorkflowLaunchInput | WorkflowLaunchToolInput): void {
    if (!("args" in input) || input.args === undefined) return;
    try {
        if (!Value.Check(workflowArgsSchema, input.args)) {
            throw new Error("Workflow args do not match the bounded JSON input shape.");
        }
        const encoded = JSON.stringify(input.args);
        if (
            encoded === undefined ||
            new TextEncoder().encode(encoded).byteLength > MAX_WORKFLOW_ARGS_BYTES
        ) {
            throw new Error("Workflow args exceed their encoded-byte bound.");
        }
    } catch (error: unknown) {
        if (error instanceof Error) throw error;
        throw new Error("Workflow args are not valid JSON.");
    }
}

function normalizeLaunchInput(
    input: WorkflowLaunchInput | WorkflowLaunchToolInput,
    operationId: string,
): WorkflowLaunchRequest {
    if ("workflow" in input) {
        const normalizedInput = normalizeWorkflowInput(input.input);
        return {
            workflow: input.workflow,
            ...(normalizedInput === undefined ? {} : { input: normalizedInput }),
            operationId,
        };
    }

    const requestedName = input.name?.trim();
    const workflow =
        requestedName === undefined || requestedName.length === 0
            ? "scriptPath" in input
                ? workflowNameFromScriptPath(input.scriptPath)
                : "dynamic-workflow"
            : requestedName;
    const description = input.description?.trim();
    const normalizedDescription =
        description === undefined || description.length === 0 ? `Run ${workflow}` : description;
    const args = input.args === undefined ? undefined : structuredClone(input.args);
    const source =
        "script" in input
            ? { script: normalizeWorkflowScript(input.script) }
            : { scriptPath: input.scriptPath };
    return {
        workflow,
        ...source,
        ...(args === undefined ? {} : { args }),
        ...(requestedName === undefined || requestedName.length === 0
            ? {}
            : { name: requestedName }),
        description: normalizedDescription,
        ...(input.resumeFromRunId === undefined ? {} : { resumeFromRunId: input.resumeFromRunId }),
        operationId,
    };
}

function workflowNameFromScriptPath(path: string): string {
    const leaf = path.split(/[\\/]/u).at(-1)?.replace(/\.py$/iu, "") ?? "";
    return leaf.length > 0 && leaf.length <= MAX_WORKFLOW_NAME_LENGTH ? leaf : "dynamic-workflow";
}

function normalizeWorkflowRun(run: WorkflowRun): WorkflowObservedRun {
    const normalized = {
        ...structuredClone(run),
        agentCount: run.agentCount ?? 0,
        logs: run.logs === undefined ? [] : [...run.logs],
        logsTruncated: run.logsTruncated ?? false,
        legacyStatus: workflowLegacyStatusFor(run.status),
    };
    assertWorkflowObservedRun(normalized);
    return normalized;
}

function assertRunOwner(run: WorkflowRun, agentId: string, message: string): void {
    if (run.agentId !== agentId) throw new Error(message);
}

function assertRunId(run: WorkflowRun, id: string, message: string): void {
    if (run.id !== id) throw new Error(message);
}

function assertLaunchResult(run: WorkflowRun, request: WorkflowLaunchRequest): void {
    if (
        run.id !== request.operationId ||
        run.workflow !== request.workflow ||
        run.input !== request.input
    ) {
        throw new Error("Workflow runtime returned a run with the wrong identity or input.");
    }
}

function assertMutationOwner(
    mutation: WorkflowMutationResult,
    agentId: string,
    request: WorkflowMutationRequest,
): void {
    if (
        mutation.agentId !== agentId ||
        mutation.operationId !== request.operationId ||
        mutation.run.agentId !== agentId ||
        mutation.run.id !== request.id
    ) {
        throw new Error("Workflow runtime returned an unrelated mutation.");
    }
}

function assertMutationTransition(
    before: WorkflowRun,
    after: WorkflowRun,
    id: string,
    operation: "cancel" | "resume",
): boolean {
    assertRunId(after, id, "Workflow operation returned the wrong identity.");
    if (operation === "cancel") {
        if (isWorkflowTerminalStatus(before.status)) {
            if (!sameWorkflowRunObject(before, after)) {
                throw new Error("Workflow terminal cancellation must be an exact no-op.");
            }
            return false;
        }
        if (after.status !== "cancelled") {
            throw new Error("Workflow cancellation did not produce a cancelled run.");
        }
    } else {
        if (before.status === "running") {
            if (!sameWorkflowRunObject(before, after)) {
                throw new Error("Workflow running resume must be an exact no-op.");
            }
            return false;
        }
        if (before.status !== "paused" || after.status !== "running") {
            throw new Error("Only a paused workflow run can be resumed.");
        }
    }
    assertWorkflowMutationFieldsPreserved(before, after);
    if (after.updatedAt <= before.updatedAt) {
        throw new Error("Workflow mutation timestamp must advance.");
    }
    return true;
}

function workflowMutationInvokesRuntime(
    before: WorkflowRun,
    operation: "cancel" | "resume",
): boolean {
    if (operation === "cancel") return !isWorkflowTerminalStatus(before.status);
    if (before.status === "paused") return true;
    if (before.status === "running") return false;
    throw new Error("Only a paused workflow run can be resumed.");
}

function assertWorkflowMutationFieldsPreserved(before: WorkflowRun, after: WorkflowRun): void {
    for (const key of [
        "agentId",
        "workflow",
        "input",
        "createdAt",
        "startedAt",
        "output",
    ] as const) {
        if (!sameWorkflowRunField(before, after, key)) {
            throw new Error("Workflow operation changed fields outside its lifecycle transition.");
        }
    }
}

function sameWorkflowRunObject(left: WorkflowRun, right: WorkflowRun): boolean {
    const keys = [
        "id",
        "agentId",
        "workflow",
        "status",
        "input",
        "output",
        "error",
        "createdAt",
        "updatedAt",
        "startedAt",
        "pausedAt",
        "finishedAt",
        "agentCount",
        "logs",
        "logsTruncated",
        "legacyStatus",
    ] as const;
    return keys.every((key) => sameWorkflowRunField(left, right, key));
}

function sameWorkflowRunField(
    left: WorkflowRun,
    right: WorkflowRun,
    key:
        | "id"
        | "agentId"
        | "workflow"
        | "status"
        | "input"
        | "output"
        | "error"
        | "createdAt"
        | "updatedAt"
        | "startedAt"
        | "pausedAt"
        | "finishedAt"
        | "agentCount"
        | "logs"
        | "logsTruncated"
        | "legacyStatus",
): boolean {
    const leftHasKey = Object.prototype.hasOwnProperty.call(left, key);
    const rightHasKey = Object.prototype.hasOwnProperty.call(right, key);
    if (key === "logs" && leftHasKey && rightHasKey) {
        const leftLogs = left.logs;
        const rightLogs = right.logs;
        return (
            leftLogs !== undefined &&
            rightLogs !== undefined &&
            leftLogs.length === rightLogs.length &&
            leftLogs.every((line, index) => line === rightLogs[index])
        );
    }
    return (
        leftHasKey === rightHasKey &&
        (!leftHasKey || Reflect.get(left, key) === Reflect.get(right, key))
    );
}

function isWorkflowTerminalStatus(status: WorkflowRun["status"]): boolean {
    return (
        status === "completed" ||
        status === "failed" ||
        status === "cancelled" ||
        status === "unavailable"
    );
}

function assertWorkflowPageOwner(page: WorkflowPage, agentId: string): void {
    if (page.agentId !== agentId) throw new Error("Workflow store returned another agent's page.");
    for (const run of page.runs) {
        assertRunOwner(run, agentId, "Workflow store returned a run for another agent.");
    }
}

function assertWorkflowPageRecords(page: WorkflowPage, query: WorkflowPageQuery): void {
    let previousId: string | undefined;
    for (const run of page.runs) {
        if (query.includeTerminal === false && isWorkflowTerminalStatus(run.status)) {
            throw new Error("Workflow store returned a terminal run outside the requested filter.");
        }
        if (previousId !== undefined && previousId >= run.id) {
            throw new Error("Workflow store returned duplicate or unordered run identities.");
        }
        previousId = run.id;
    }
}

function assertExactOffsetPage(page: WorkflowPage, query: WorkflowPageQuery, limit: number): void {
    assertExactOffsetCursors(
        page.cursor,
        page.totalRuns,
        page.runs.length,
        page.previousCursor,
        page.nextCursor,
        queryCursor(query),
        query.from,
        limit,
        "workflow",
    );
}

function assertExactLogPage(page: WorkflowLogPage, query: WorkflowLogQuery, limit: number): void {
    assertExactOffsetCursors(
        page.cursor,
        page.totalLines,
        page.lines.length,
        page.previousCursor,
        page.nextCursor,
        queryCursor(query),
        query.from,
        limit,
        "workflow log",
    );
    for (const [index, line] of page.lines.entries()) {
        if (line.position !== page.cursor + index) {
            throw new Error("Workflow store returned unordered log positions.");
        }
    }
}

function assertExactOffsetCursors(
    cursor: number,
    total: number,
    visibleCount: number,
    previousCursor: number | undefined,
    nextCursor: number | undefined,
    requestedCursor: number | undefined,
    from: "start" | "end" | undefined,
    limit: number,
    label: string,
): void {
    const expectedCursor = from === "end" ? Math.max(0, total - limit) : (requestedCursor ?? 0);
    const expectedCount = Math.min(limit, Math.max(0, total - expectedCursor));
    const expectedNext =
        expectedCursor + expectedCount < total ? expectedCursor + expectedCount : undefined;
    const backwardAnchor = Math.min(expectedCursor, total);
    const expectedPrevious = backwardAnchor === 0 ? undefined : Math.max(0, backwardAnchor - limit);
    if (cursor !== expectedCursor || visibleCount !== expectedCount) {
        throw new Error(`${label} page did not return the exact requested offset window.`);
    }
    if (nextCursor !== expectedNext)
        throw new Error(`${label} page returned an invalid next cursor.`);
    if (previousCursor !== expectedPrevious) {
        throw new Error(`${label} page returned an invalid previous cursor.`);
    }
}

function queryCursor(query: WorkflowPageQuery | WorkflowLogQuery): number | undefined {
    return "cursor" in query ? query.cursor : undefined;
}

function formatCursorSuffix(
    previousCursor: number | undefined,
    nextCursor: number | undefined,
): string {
    return [
        ...(previousCursor === undefined ? [] : [`prev:${previousCursor}`]),
        ...(nextCursor === undefined ? [] : [`next:${nextCursor}`]),
    ]
        .map((line) => `\n${line}`)
        .join("");
}

function formatRunRow(run: WorkflowRun): string {
    return `${run.id}: ${run.workflow} [${run.status}]`;
}

function formatCompactRunForModel(run: WorkflowRun, maxCharacters: number): string {
    const logs = run.logs ?? [];
    const lines = [
        `${run.id}/${run.workflow}`,
        `s:${run.status}`,
        `l:${run.legacyStatus ?? workflowLegacyStatusFor(run.status)}`,
        `a:${run.agentCount ?? 0}`,
        `g:${logs.length}`,
    ];
    let output = lines.join("\n");
    let logsTruncated = run.logsTruncated === true;
    if (logs.length > 0) logsTruncated = true;
    if (logsTruncated) {
        output += "\nlogs_truncated";
    }
    if (output.length <= maxCharacters) return output;
    return lines.join("\n");
}
