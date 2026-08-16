import { sql } from "drizzle-orm";
import { agentDatabaseRows, agentDatabaseRun } from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";
import { Value } from "@sinclair/typebox/value";

import {
    MAX_WORKFLOW_PAGE_SIZE,
    workflowAgentIdSchema,
    workflowIdSchema,
    workflowLogPageSchema,
    workflowLogQuerySchema,
    workflowMutationRequestSchema,
    workflowPageQuerySchema,
    workflowPageSchema,
    type WorkflowLogPage,
    type WorkflowLogQuery,
    type WorkflowMutationRequest,
    type WorkflowMutationResult,
    type WorkflowPage,
    type WorkflowPageQuery,
    type WorkflowRun,
    type WorkflowLaunchRequest,
    workflowLaunchRequestSchema,
} from "./Workflow.js";
import {
    assertWorkflowLogPage,
    assertWorkflowMutationResult,
    assertWorkflowPage,
    assertWorkflowRun,
    type WorkflowRuntime,
    type WorkflowStore,
} from "./WorkflowStore.js";

export const WORKFLOW_RUNS_TABLE = "happy_agent_module_workflow_runs";
export const WORKFLOW_LOGS_TABLE = "happy_agent_module_workflow_logs";
export const WORKFLOW_RECEIPTS_TABLE = "happy_agent_module_workflow_receipts";
export const WORKFLOW_PROOFS_TABLE = "happy_agent_module_workflow_proofs";
export const WORKFLOWS_MIGRATION_KEY = "001-workflows-runs";

type JsonRow = { readonly value_json: string };
type CountRow = { readonly count: number | string };
type LogRow = { readonly position: number | string; readonly text: string };
export type WorkflowDatabase = WorkflowStore;

export function createWorkflowDatabase(runtime: WorkflowRuntime): WorkflowDatabase {
    const decode = <ValueType>(
        row: JsonRow,
        label: string,
        validate: (value: unknown) => asserts value is ValueType,
    ): ValueType => {
        let parsed: unknown;
        try {
            parsed = JSON.parse(row.value_json);
        } catch {
            throw new Error(`${label} contains invalid JSON.`);
        }
        validate(parsed);
        return structuredClone(parsed);
    };

    const readRun = async (
        ctx: Context,
        agentId: string,
        id: string,
    ): Promise<WorkflowRun | undefined> => {
        const row = (
            await agentDatabaseRows<JsonRow>(
                ctx.db,
                sql`SELECT run_json AS value_json
                    FROM ${sql.raw(WORKFLOW_RUNS_TABLE)}
                    WHERE agent_id = ${agentId} AND id = ${id}
                    LIMIT 1`,
            )
        )[0];
        return row === undefined ? undefined : decode(row, "Workflow run", assertWorkflowRun);
    };

    const writeRun = async (ctx: Context, run: WorkflowRun, mode: "insert" | "update") => {
        assertWorkflowRun(run);
        if (mode === "insert") {
            await agentDatabaseRun(
                ctx.db,
                sql`INSERT INTO ${sql.raw(WORKFLOW_RUNS_TABLE)}
                    (agent_id, id, workflow, status, created_at, updated_at, run_json)
                    VALUES (
                        ${run.agentId}, ${run.id}, ${run.workflow}, ${run.status},
                        ${run.createdAt}, ${run.updatedAt}, ${JSON.stringify(run)}
                    )`,
            );
            return;
        }
        await agentDatabaseRun(
            ctx.db,
            sql`UPDATE ${sql.raw(WORKFLOW_RUNS_TABLE)}
                SET workflow = ${run.workflow}, status = ${run.status},
                    created_at = ${run.createdAt}, updated_at = ${run.updatedAt},
                    run_json = ${JSON.stringify(run)}
                WHERE agent_id = ${run.agentId} AND id = ${run.id}`,
        );
    };

    const runtimeLaunch = async (
        ctx: Context,
        agentId: string,
        request: WorkflowLaunchRequest,
    ): Promise<WorkflowRun> => {
        const run = await runtime.launch.call(runtime, ctx, agentId, request);
        assertWorkflowRun(run);
        if (run.agentId !== agentId || run.id !== request.operationId) {
            throw new Error("Workflow runtime returned an unrelated launch.");
        }
        return structuredClone(run);
    };

    const runtimeMutation = async (
        ctx: Context,
        agentId: string,
        request: WorkflowMutationRequest,
        operation: "cancel" | "resume",
    ): Promise<WorkflowMutationResult> => {
        const result =
            operation === "cancel"
                ? await runtime.cancel.call(runtime, ctx, agentId, request)
                : await runtime.resume.call(runtime, ctx, agentId, request);
        assertWorkflowMutationResult(result);
        if (
            result.agentId !== agentId ||
            result.operationId !== request.operationId ||
            result.run.id !== request.id ||
            result.run.agentId !== agentId
        ) {
            throw new Error("Workflow runtime returned an unrelated mutation.");
        }
        return structuredClone(result);
    };

    return {
        launch: async (ctx, agentId, request) => {
            if (
                !Value.Check(workflowAgentIdSchema, agentId) ||
                !Value.Check(workflowLaunchRequestSchema, request)
            ) {
                throw new Error("Workflow launch input is invalid.");
            }
            return await runtimeLaunch(ctx, agentId, request);
        },
        get: async (ctx, agentId, id) => {
            if (
                !Value.Check(workflowAgentIdSchema, agentId) ||
                !Value.Check(workflowIdSchema, id)
            ) {
                throw new Error("Workflow get input is invalid.");
            }
            return await readRun(ctx, agentId, id);
        },
        list: async (ctx, agentId, query) => {
            if (
                !Value.Check(workflowAgentIdSchema, agentId) ||
                !Value.Check(workflowPageQuerySchema, query)
            ) {
                throw new Error("Workflow page query is invalid.");
            }
            const limit = Math.min(query.limit ?? MAX_WORKFLOW_PAGE_SIZE, MAX_WORKFLOW_PAGE_SIZE);
            const terminalPredicate =
                query.includeTerminal === false
                    ? sql`AND status NOT IN ('completed', 'failed', 'cancelled', 'unavailable')`
                    : sql``;
            const countRows = await agentDatabaseRows<CountRow>(
                ctx.db,
                sql`SELECT COUNT(*) AS count
                    FROM ${sql.raw(WORKFLOW_RUNS_TABLE)}
                    WHERE agent_id = ${agentId} ${terminalPredicate}`,
            );
            const total = Number(countRows[0]?.count ?? 0);
            const requested =
                query.from === "end"
                    ? Math.max(0, total - limit)
                    : "cursor" in query
                      ? (query.cursor ?? 0)
                      : 0;
            const offset = Math.max(0, Math.min(requested, total));
            const rows = await agentDatabaseRows<JsonRow>(
                ctx.db,
                sql`SELECT run_json AS value_json
                    FROM ${sql.raw(WORKFLOW_RUNS_TABLE)}
                    WHERE agent_id = ${agentId} ${terminalPredicate}
                    ORDER BY id
                    LIMIT ${limit} OFFSET ${offset}`,
            );
            const runs = rows.map((row) => decode(row, "Workflow run", assertWorkflowRun));
            const page: WorkflowPage = {
                agentId,
                cursor: offset,
                runs,
                totalRuns: total,
                ...(offset > 0 ? { previousCursor: Math.max(0, offset - limit) } : {}),
                ...(offset + runs.length < total ? { nextCursor: offset + runs.length } : {}),
            };
            assertWorkflowPage(page);
            return page;
        },
        cancel: async (ctx, agentId, request) => {
            if (
                !Value.Check(workflowAgentIdSchema, agentId) ||
                !Value.Check(workflowMutationRequestSchema, request)
            ) {
                throw new Error("Workflow cancellation input is invalid.");
            }
            return await runtimeMutation(ctx, agentId, request, "cancel");
        },
        resume: async (ctx, agentId, request) => {
            if (
                !Value.Check(workflowAgentIdSchema, agentId) ||
                !Value.Check(workflowMutationRequestSchema, request)
            ) {
                throw new Error("Workflow resume input is invalid.");
            }
            return await runtimeMutation(ctx, agentId, request, "resume");
        },
        wait: async (ctx, agentId, id) => {
            if (
                !Value.Check(workflowAgentIdSchema, agentId) ||
                !Value.Check(workflowIdSchema, id)
            ) {
                throw new Error("Workflow wait input is invalid.");
            }
            const run = await runtime.wait.call(runtime, ctx, agentId, id, ctx.lifetime);
            assertWorkflowRun(run);
            if (run.agentId !== agentId || run.id !== id) {
                throw new Error("Workflow runtime returned an unrelated wait result.");
            }
            return structuredClone(run);
        },
        save: async (ctx, run) => {
            assertWorkflowRun(run);
            await writeRun(
                ctx,
                run,
                (await readRun(ctx, run.agentId, run.id)) === undefined ? "insert" : "update",
            );
        },
        logs: async (ctx, agentId, query) => {
            if (
                !Value.Check(workflowAgentIdSchema, agentId) ||
                !Value.Check(workflowLogQuerySchema, query)
            ) {
                throw new Error("Workflow log query is invalid.");
            }
            const run = await readRun(ctx, agentId, query.id);
            if (run === undefined) throw new Error("Workflow run was not found.");
            const countRows = await agentDatabaseRows<CountRow>(
                ctx.db,
                sql`SELECT COUNT(*) AS count
                    FROM ${sql.raw(WORKFLOW_LOGS_TABLE)}
                    WHERE agent_id = ${agentId} AND run_id = ${query.id}`,
            );
            const totalLines = Number(countRows[0]?.count ?? 0);
            const limit = Math.min(query.limit ?? 200, 500);
            const requested =
                query.from === "end"
                    ? Math.max(0, totalLines - limit)
                    : "cursor" in query
                      ? (query.cursor ?? 0)
                      : 0;
            const cursor = Math.max(0, Math.min(requested, totalLines));
            const rawLines = await agentDatabaseRows<LogRow>(
                ctx.db,
                sql`SELECT position, text
                    FROM ${sql.raw(WORKFLOW_LOGS_TABLE)}
                    WHERE agent_id = ${agentId} AND run_id = ${query.id}
                    ORDER BY position
                    LIMIT ${limit} OFFSET ${cursor}`,
            );
            const lines = rawLines.map((line) => ({
                position: Number(line.position),
                text: line.text,
            }));
            const page: WorkflowLogPage = {
                agentId,
                id: query.id,
                cursor,
                lines,
                totalLines,
                ...(cursor > 0 ? { previousCursor: Math.max(0, cursor - limit) } : {}),
                ...(cursor + lines.length < totalLines
                    ? { nextCursor: cursor + lines.length }
                    : {}),
            };
            assertWorkflowLogPage(page);
            return page;
        },
    };
}
