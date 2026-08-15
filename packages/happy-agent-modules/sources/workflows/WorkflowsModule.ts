import { sql } from "drizzle-orm";
import {
    agentDatabaseRun,
    type AgentDatabase,
    type AgentModule,
    type AgentModuleMigration,
    type AgentModuleScope,
    type AgentStorageTransaction,
    type AgentToolCall,
    type AnyAgentTool,
} from "@slopus/happy-agent-base";
import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { afterCommit, type Context } from "@steve.kite/stdlib";

import {
    MAX_WORKFLOW_CURSOR,
    MAX_WORKFLOW_ID_LENGTH,
    MAX_WORKFLOW_LOG_LINE_LENGTH,
    MAX_WORKFLOW_LOG_LINES,
    MAX_WORKFLOW_NAME_LENGTH,
    MAX_WORKFLOW_OUTPUT_CHARACTERS,
    MAX_WORKFLOW_PAGE_SIZE,
    workflowAgentIdSchema,
    workflowIdSchema,
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
    assertWorkflowPage,
    assertWorkflowRun,
    assertWorkflowTransactionChange,
    workflowRuntimeSchema,
    type WorkflowRuntime,
    type WorkflowTransactionChange,
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
        transaction: Type.Function(
            [
                Type.Unsafe<Context>(Type.Object({}, { additionalProperties: false })),
                Type.Function(
                    [
                        Type.Unsafe<Context>(Type.Object({}, { additionalProperties: false })),
                        Type.Unknown(),
                    ],
                    Type.Promise(Type.Unknown()),
                ),
            ],
            Type.Promise(Type.Unknown()),
        ),
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

type RunToolCall = Pick<AgentToolCall<typeof workflowRunSchema>, "id" | "commit">;
type MutationToolCall = Pick<AgentToolCall<typeof workflowMutationResultSchema>, "id" | "commit">;
type Complete<Result> = (ctx: Context, result: Result) => Promise<Result>;

export class WorkflowsModule implements AgentModule {
    readonly name = "workflows";
    readonly #store: WorkflowDatabase;
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
            async (_ctx, database) => {
                await agentDatabaseRun(
                    database as AgentDatabase,
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
                    database as AgentDatabase,
                    sql`CREATE INDEX IF NOT EXISTS ${sql.raw(`${WORKFLOW_RUNS_TABLE}_agent_status_id`)}
                        ON ${sql.raw(WORKFLOW_RUNS_TABLE)} (agent_id, status, id)`,
                );
                await agentDatabaseRun(
                    database as AgentDatabase,
                    sql`CREATE TABLE IF NOT EXISTS ${sql.raw(WORKFLOW_LOGS_TABLE)} (
                        agent_id TEXT NOT NULL,
                        run_id TEXT NOT NULL,
                        position BIGINT NOT NULL,
                        text TEXT NOT NULL,
                        PRIMARY KEY (agent_id, run_id, position)
                    )`,
                );
                await agentDatabaseRun(
                    database as AgentDatabase,
                    sql`CREATE TABLE IF NOT EXISTS ${sql.raw(WORKFLOW_RECEIPTS_TABLE)} (
                        agent_id TEXT NOT NULL,
                        operation_id TEXT NOT NULL,
                        value_json TEXT NOT NULL,
                        PRIMARY KEY (agent_id, operation_id)
                    )`,
                );
                await agentDatabaseRun(
                    database as AgentDatabase,
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
            async (_ctx, database) => {
                await agentDatabaseRun(
                    database as AgentDatabase,
                    sql`DROP TABLE IF EXISTS ${sql.raw(WORKFLOW_RECEIPTS_TABLE)}`,
                );
                await agentDatabaseRun(
                    database as AgentDatabase,
                    sql`DROP TABLE IF EXISTS ${sql.raw(WORKFLOW_PROOFS_TABLE)}`,
                );
            },
        ],
    ];

    constructor(options: WorkflowModuleOptions) {
        if (!Value.Check(workflowModuleOptionsSchema, options)) {
            throw new Error("Workflow module options are invalid.");
        }
        this.#store = createWorkflowDatabase(
            options.runtime as WorkflowRuntime,
            options.transaction as AgentStorageTransaction,
        );
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

    readonly tools = (_ctx: Context, scope: AgentModuleScope): readonly AnyAgentTool[] => [
        runWorkflowTool(this, scope.agent.id),
        listWorkflowsTool(this, scope.agent.id),
        workflowStatusTool(this, scope.agent.id),
        cancelWorkflowTool(this, scope.agent.id),
        resumeWorkflowTool(this, scope.agent.id),
        waitWorkflowTool(this, scope.agent.id),
        workflowLogsTool(this, scope.agent.id),
    ];

    async launch(ctx: Context, agentId: string, input: WorkflowLaunchInput): Promise<WorkflowRun> {
        this.#assertAgentId(agentId);
        this.#assertInput(workflowLaunchInputSchema, input, "workflow launch");
        const normalized = normalizeLaunchInput(input);
        const operationId = normalized.operationId ?? (await this.#newOperationId(ctx, agentId));
        return await this.#launch(
            ctx,
            agentId,
            { ...normalized, operationId },
            async (_txCtx, run) => run,
        );
    }

    async launchForTool(
        ctx: Context,
        agentId: string,
        input: WorkflowLaunchToolInput,
        call: RunToolCall,
    ): Promise<WorkflowRun> {
        this.#assertAgentId(agentId);
        this.#assertInput(workflowLaunchToolInputSchema, input, "workflow launch tool");
        this.#assertId(call.id);
        const normalizedInput = normalizeWorkflowInput(input.input);
        return await this.#launch(
            ctx,
            agentId,
            {
                workflow: input.workflow,
                ...(normalizedInput === undefined ? {} : { input: normalizedInput }),
                operationId: call.id,
            },
            async (txCtx, run) => await call.commit(txCtx, run),
        );
    }

    async status(ctx: Context, agentId: string, id: string): Promise<WorkflowRun | undefined> {
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
        return await this.#publicMutation(ctx, agentId, input, "cancel");
    }

    async cancelForTool(
        ctx: Context,
        agentId: string,
        input: WorkflowMutationToolInput,
        call: MutationToolCall,
    ): Promise<WorkflowMutationResult> {
        return await this.#toolMutation(ctx, agentId, input, call, "cancel");
    }

    async resume(
        ctx: Context,
        agentId: string,
        input: WorkflowMutationInput,
    ): Promise<WorkflowMutationResult> {
        return await this.#publicMutation(ctx, agentId, input, "resume");
    }

    async resumeForTool(
        ctx: Context,
        agentId: string,
        input: WorkflowMutationToolInput,
        call: MutationToolCall,
    ): Promise<WorkflowMutationResult> {
        return await this.#toolMutation(ctx, agentId, input, call, "resume");
    }

    async wait(ctx: Context, agentId: string, id: string): Promise<WorkflowRun> {
        this.#assertAgentId(agentId);
        this.#assertId(id);
        const run = await this.#waitStoreRun(ctx, agentId, id);
        assertRunOwner(run, agentId, "Workflow store returned a run for another agent.");
        assertRunId(run, id, "Workflow store returned the wrong run.");
        if (!isWorkflowTerminalStatus(run.status)) {
            throw new Error("Workflow wait returned before a terminal or unavailable status.");
        }
        return structuredClone(run);
    }

    async logs(ctx: Context, agentId: string, query: WorkflowLogQuery): Promise<WorkflowLogPage> {
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
        const pieces = [`${run.id}: ${run.workflow}`, `status: ${run.status}`];
        for (const [label, value] of [
            ["output", "output" in run ? run.output : undefined],
            ["error", "error" in run ? run.error : undefined],
        ] as const) {
            if (value === undefined) continue;
            const prefix = `${label}: `;
            const available =
                this.#maxOutputCharacters - pieces.join("\n").length - 1 - prefix.length;
            if (available <= 0) break;
            pieces.push(`${prefix}${value.slice(0, available)}`);
        }
        return pieces.join("\n");
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
        complete: Complete<WorkflowRun>,
    ): Promise<WorkflowRun> {
        let completed: WorkflowRun | undefined;
        const change = await this.#transaction(ctx, agentId, async (txCtx) => {
            const existing = await this.#getStoreRun(txCtx, agentId, request.operationId);
            if (existing !== undefined) {
                throw new Error(`Workflow run "${request.operationId}" already exists.`);
            }
            const launched = await this.#launchStoreRun(
                txCtx,
                agentId,
                structuredClone(request),
            );
            assertRunOwner(launched, agentId, "Workflow runtime returned a run for another agent.");
            assertLaunchResult(launched, request);
            const persisted = await this.#getStoreRun(txCtx, agentId, request.operationId);
            if (persisted === undefined) {
                throw new Error("Workflow runtime did not persist the launched run.");
            }
            assertRunOwner(
                persisted,
                agentId,
                "Workflow runtime persisted a run for another agent.",
            );
            assertLaunchResult(persisted, request);
            if (!sameWorkflowRunObject(launched, persisted)) {
                throw new Error("Workflow runtime returned a launch different from storage.");
            }
            const event = await this.#createEvent(txCtx, "workflow_started", agentId, persisted);
            completed = await complete(txCtx, structuredClone(persisted));
            return {
                agentId,
                operationId: request.operationId,
                run: persisted,
                changed: true,
                event,
            };
        });
        assertRunOwner(change.run, agentId, "Workflow transaction returned another agent's run.");
        assertRunId(change.run, request.operationId, "Workflow transaction returned the wrong run.");
        if (completed === undefined || !sameWorkflowRunObject(completed, change.run)) {
            throw new Error("Workflow launch completion returned a substituted run.");
        }
        return structuredClone(completed);
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
        return await this.#mutate(
            ctx,
            agentId,
            { id: input.id, operationId },
            operation,
            async (_txCtx, result) => result,
        );
    }

    async #toolMutation(
        ctx: Context,
        agentId: string,
        input: WorkflowMutationToolInput,
        call: MutationToolCall,
        operation: "cancel" | "resume",
    ): Promise<WorkflowMutationResult> {
        this.#assertAgentId(agentId);
        this.#assertInput(workflowMutationToolInputSchema, input, `workflow ${operation} tool`);
        this.#assertId(call.id);
        return await this.#mutate(
            ctx,
            agentId,
            { id: input.id, operationId: call.id },
            operation,
            async (txCtx, result) => await call.commit(txCtx, result),
        );
    }

    async #mutate(
        ctx: Context,
        agentId: string,
        request: WorkflowMutationRequest,
        operation: "cancel" | "resume",
        complete: Complete<WorkflowMutationResult>,
    ): Promise<WorkflowMutationResult> {
        let completed: WorkflowMutationResult | undefined;
        const change = await this.#transaction(ctx, agentId, async (txCtx) => {
            const current = await this.#getStoreRun(txCtx, agentId, request.id);
            if (current === undefined) throw new Error("Workflow mutation target was not found.");
            assertRunOwner(current, agentId, "Workflow store returned another agent's run.");
            assertRunId(current, request.id, "Workflow store returned the wrong run.");
            let mutation: WorkflowMutationResult;
            let after: WorkflowRun;
            if (workflowMutationInvokesRuntime(current, operation)) {
                mutation = await this.#mutateStoreRun(
                    txCtx,
                    agentId,
                    structuredClone(request),
                    operation,
                );
                assertMutationOwner(mutation, agentId, request);
                const persisted = await this.#getStoreRun(txCtx, agentId, request.id);
                if (persisted === undefined) {
                    throw new Error("Workflow runtime removed its target run.");
                }
                after = persisted;
            } else {
                after = structuredClone(current);
                mutation = {
                    agentId,
                    operationId: request.operationId,
                    run: after,
                    changed: false,
                };
            }
            const changed = assertMutationTransition(current, after, request.id, operation);
            if (
                mutation.changed !== changed ||
                mutation.operationId !== request.operationId ||
                !sameWorkflowRunObject(mutation.run, after)
            ) {
                throw new Error("Workflow runtime result did not match the stored transition.");
            }
            const result: WorkflowMutationResult = {
                agentId,
                operationId: request.operationId,
                run: structuredClone(after),
                changed,
            };
            completed = await complete(txCtx, structuredClone(result));
            if (!changed) {
                return {
                    agentId,
                    operationId: request.operationId,
                    run: after,
                    changed: false,
                };
            }
            const event = await this.#createEvent(
                txCtx,
                operation === "cancel" ? "workflow_cancelled" : "workflow_updated",
                agentId,
                after,
            );
            return {
                agentId,
                operationId: request.operationId,
                run: after,
                changed: true,
                event,
            };
        });
        if (
            completed === undefined ||
            completed.agentId !== agentId ||
            completed.operationId !== request.operationId ||
            completed.changed !== change.changed ||
            !sameWorkflowRunObject(completed.run, change.run)
        ) {
            throw new Error(`Workflow ${operation} completion returned a substituted result.`);
        }
        return structuredClone(completed);
    }

    async #transaction(
        ctx: Context,
        agentId: string,
        work: (txCtx: Context) => Promise<WorkflowTransactionChange>,
    ): Promise<WorkflowTransactionChange> {
        const raw: unknown = Reflect.apply(this.#store.transaction, this.#store, [
            ctx,
            agentId,
            work,
        ]);
        const resolved = await workflowStorePromise(raw, "transaction");
        assertWorkflowTransactionChange(resolved);
        return resolved;
    }

    async #launchStoreRun(
        ctx: Context,
        agentId: string,
        request: WorkflowLaunchRequest,
    ): Promise<WorkflowRun> {
        const raw: unknown = Reflect.apply(this.#store.launch, this.#store, [
            ctx,
            agentId,
            request,
        ]);
        const resolved = await workflowStorePromise(raw, "launch");
        assertWorkflowRun(resolved);
        return resolved;
    }

    async #getStoreRun(
        ctx: Context,
        agentId: string,
        id: string,
    ): Promise<WorkflowRun | undefined> {
        const raw: unknown = Reflect.apply(this.#store.get, this.#store, [ctx, agentId, id]);
        const resolved = await workflowStorePromise(raw, "get");
        if (resolved === undefined) return undefined;
        assertWorkflowRun(resolved);
        return resolved;
    }

    async #listStorePage(
        ctx: Context,
        agentId: string,
        query: WorkflowPageQuery,
    ): Promise<WorkflowPage> {
        const raw: unknown = Reflect.apply(this.#store.list, this.#store, [ctx, agentId, query]);
        const resolved = await workflowStorePromise(raw, "list");
        assertWorkflowPage(resolved);
        return resolved;
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
        return resolved;
    }

    async #waitStoreRun(ctx: Context, agentId: string, id: string): Promise<WorkflowRun> {
        const raw: unknown = Reflect.apply(this.#store.wait, this.#store, [ctx, agentId, id]);
        const resolved = await workflowStorePromise(raw, "wait");
        assertWorkflowRun(resolved);
        return resolved;
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

function normalizeLaunchInput(input: WorkflowLaunchInput): WorkflowLaunchInput {
    const normalizedInput = normalizeWorkflowInput(input.input);
    return {
        workflow: input.workflow,
        ...(normalizedInput === undefined ? {} : { input: normalizedInput }),
        ...(input.operationId === undefined ? {} : { operationId: input.operationId }),
    };
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
        | "finishedAt",
): boolean {
    const leftHasKey = Object.prototype.hasOwnProperty.call(left, key);
    const rightHasKey = Object.prototype.hasOwnProperty.call(right, key);
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
    if (nextCursor !== expectedNext) throw new Error(`${label} page returned an invalid next cursor.`);
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