import {
    MAX_WORKFLOW_LOG_LINE_LENGTH,
    assertWorkflowMutationProof,
    assertWorkflowOperationReceipt,
    assertWorkflowRun,
    type WorkflowLogPage,
    type WorkflowLogQuery,
    type WorkflowMutationProof,
    type WorkflowMutationRequest,
    type WorkflowMutationResult,
    type WorkflowOperationReceipt,
    type WorkflowPage,
    type WorkflowPageQuery,
    type WorkflowRun,
    type WorkflowStore,
    type WorkflowTransactionChange,
    type WorkflowLaunchRequest,
} from "@slopus/happy-agent-features";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";
import { and, asc, eq, sql } from "drizzle-orm";

import {
    workflowLogs,
    workflowMutationProofs,
    workflowOperationReceipts,
    workflowRuns,
} from "../../persistence/database/schema.js";
import type { SessionDatabase } from "../../persistence/database/SessionDatabase.js";
import {
    deferSessionTransactionCommit,
    runSessionTransaction,
} from "../../persistence/database/SessionTransactionContext.js";
import { inDatabase } from "../../persistence/database/inDatabase.js";
import { withDatabase } from "../../persistence/databaseContext.js";

const unavailableReason = "Workflow execution is unavailable because no runner is configured.";
const jsonRowSchema = Type.Object({ value: Type.String() }, { additionalProperties: false });
const countRowSchema = Type.Object(
    { count: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }) },
    { additionalProperties: false },
);
const logRowSchema = Type.Object(
    {
        position: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
        text: Type.String({ maxLength: MAX_WORKFLOW_LOG_LINE_LENGTH }),
    },
    { additionalProperties: false },
);
type JsonRow = Static<typeof jsonRowSchema>;
type CountRow = Static<typeof countRowSchema>;
type LogRow = Static<typeof logRowSchema>;

/** SQLite host port for the feature-owned workflows implementation. */
export class SqliteWorkflowStore implements WorkflowStore {
    readonly #database: SessionDatabase;

    constructor(database: SessionDatabase) {
        this.#database = database;
    }

    async transaction(
        ctx: Context,
        _agentId: string,
        work: (ctx: Context) => Promise<WorkflowTransactionChange>,
    ): Promise<WorkflowTransactionChange> {
        return await runSessionTransaction(withDatabase(ctx, this.#database), work);
    }

    afterCommit(ctx: Context, callback: (ctx: Context) => void | Promise<void>): void {
        const postCommitCtx = withDatabase(ctx, this.#database);
        void deferSessionTransactionCommit(() => callback(postCommitCtx), this.#database);
    }

    async launch(
        ctx: Context,
        agentId: string,
        request: WorkflowLaunchRequest,
    ): Promise<WorkflowRun> {
        const now = Date.now();
        const run: WorkflowRun = {
            agentId,
            createdAt: now,
            error: unavailableReason,
            finishedAt: now,
            id: request.operationId,
            ...(request.input === undefined ? {} : { input: request.input }),
            status: "unavailable",
            updatedAt: now,
            workflow: request.workflow,
        };
        assertWorkflowRun(run);
        await this.#writeRun(ctx, run, "insert");
        return structuredClone(run);
    }

    async get(ctx: Context, agentId: string, id: string): Promise<WorkflowRun | undefined> {
        return await this.#read(ctx, "rig.sql.workflow.get", async (ctx) => {
            const row = await ctx.tx
                .select({ value: workflowRuns.runJson })
                .from(workflowRuns)
                .where(and(eq(workflowRuns.agentId, agentId), eq(workflowRuns.id, id)))
                .get();
            return row === undefined ? undefined : decodeRun(row);
        });
    }

    async list(ctx: Context, agentId: string, query: WorkflowPageQuery): Promise<WorkflowPage> {
        return await this.#read(ctx, "rig.sql.workflow.list", async (ctx) => {
            const activeOnly = query.includeTerminal === false;
            const predicate = activeOnly
                ? sql`${workflowRuns.agentId} = ${agentId}
                    AND ${workflowRuns.status} NOT IN ('completed', 'failed', 'cancelled', 'unavailable')`
                : sql`${workflowRuns.agentId} = ${agentId}`;
            const countRaw: unknown = await ctx.tx
                .select({ count: sql<number>`count(*)` })
                .from(workflowRuns)
                .where(predicate)
                .get();
            const { count } = checked(countRowSchema, countRaw, "workflow count");
            const limit = query.limit ?? 50;
            const cursor =
                query.from === "end"
                    ? Math.max(0, count - limit)
                    : "cursor" in query
                      ? (query.cursor ?? 0)
                      : 0;
            const rows = await ctx.tx
                .select({ value: workflowRuns.runJson })
                .from(workflowRuns)
                .where(predicate)
                .orderBy(asc(workflowRuns.id))
                .limit(limit)
                .offset(cursor)
                .all();
            const runs = rows.map(decodeRun);
            return {
                agentId,
                cursor,
                runs,
                totalRuns: count,
                ...(cursor === 0 ? {} : { previousCursor: Math.max(0, cursor - limit) }),
                ...(cursor + runs.length < count ? { nextCursor: cursor + runs.length } : {}),
            };
        });
    }

    async cancel(
        ctx: Context,
        agentId: string,
        request: WorkflowMutationRequest,
    ): Promise<WorkflowMutationResult> {
        const current = await this.#requireRun(ctx, agentId, request.id);
        if (isTerminal(current.status)) {
            return {
                agentId,
                changed: false,
                operationId: request.operationId,
                run: current,
            };
        }
        const updatedAt = Math.max(Date.now(), current.updatedAt + 1);
        const run: WorkflowRun = {
            agentId,
            createdAt: current.createdAt,
            finishedAt: updatedAt,
            id: current.id,
            ...(current.input === undefined ? {} : { input: current.input }),
            ...(!("output" in current) || current.output === undefined
                ? {}
                : { output: current.output }),
            ...("startedAt" in current && current.startedAt !== undefined
                ? { startedAt: current.startedAt }
                : {}),
            status: "cancelled",
            updatedAt,
            workflow: current.workflow,
        };
        await this.#writeRun(ctx, run, "update");
        return { agentId, changed: true, operationId: request.operationId, run };
    }

    async resume(
        ctx: Context,
        agentId: string,
        request: WorkflowMutationRequest,
    ): Promise<WorkflowMutationResult> {
        const current = await this.#requireRun(ctx, agentId, request.id);
        if (current.status === "running") {
            return {
                agentId,
                changed: false,
                operationId: request.operationId,
                run: current,
            };
        }
        if (current.status !== "paused") throw new Error("Only a paused workflow can be resumed.");
        const updatedAt = Math.max(Date.now(), current.updatedAt + 1);
        const run: WorkflowRun = {
            agentId,
            createdAt: current.createdAt,
            id: current.id,
            ...(current.input === undefined ? {} : { input: current.input }),
            ...(current.output === undefined ? {} : { output: current.output }),
            startedAt: current.startedAt,
            status: "running",
            updatedAt,
            workflow: current.workflow,
        };
        await this.#writeRun(ctx, run, "update");
        return { agentId, changed: true, operationId: request.operationId, run };
    }

    async wait(ctx: Context, agentId: string, id: string): Promise<WorkflowRun> {
        const run = await this.#requireRun(ctx, agentId, id);
        if (!isTerminal(run.status)) {
            throw new Error("The workflow runner has not reached a terminal state.");
        }
        return run;
    }

    async logs(ctx: Context, agentId: string, query: WorkflowLogQuery): Promise<WorkflowLogPage> {
        return await this.#read(ctx, "rig.sql.workflow.logs", async (ctx) => {
            await this.#requireRunInScope(ctx, agentId, query.id);
            const countRaw: unknown = await ctx.tx
                .select({ count: sql<number>`count(*)` })
                .from(workflowLogs)
                .where(and(eq(workflowLogs.agentId, agentId), eq(workflowLogs.runId, query.id)))
                .get();
            const { count } = checked(countRowSchema, countRaw, "workflow log count");
            const limit = query.limit ?? 200;
            const cursor =
                query.from === "end"
                    ? Math.max(0, count - limit)
                    : "cursor" in query
                      ? (query.cursor ?? 0)
                      : 0;
            const rawRows: readonly unknown[] = await ctx.tx
                .select({ position: workflowLogs.position, text: workflowLogs.text })
                .from(workflowLogs)
                .where(and(eq(workflowLogs.agentId, agentId), eq(workflowLogs.runId, query.id)))
                .orderBy(asc(workflowLogs.position))
                .limit(limit)
                .offset(cursor)
                .all();
            const lines = rawRows.map((row) => checked(logRowSchema, row, "workflow log row"));
            return {
                agentId,
                cursor,
                id: query.id,
                lines,
                totalLines: count,
                ...(cursor === 0 ? {} : { previousCursor: Math.max(0, cursor - limit) }),
                ...(cursor + lines.length < count ? { nextCursor: cursor + lines.length } : {}),
            };
        });
    }

    async readReceipt(
        ctx: Context,
        agentId: string,
        operationId: string,
    ): Promise<WorkflowOperationReceipt | undefined> {
        return await this.#read(ctx, "rig.sql.workflow.read_receipt", async (ctx) => {
            const row = await ctx.tx
                .select({ value: workflowOperationReceipts.receiptJson })
                .from(workflowOperationReceipts)
                .where(
                    and(
                        eq(workflowOperationReceipts.agentId, agentId),
                        eq(workflowOperationReceipts.operationId, operationId),
                    ),
                )
                .get();
            if (row === undefined) return undefined;
            const receipt: unknown = JSON.parse(
                checked(jsonRowSchema, row, "workflow receipt").value,
            );
            assertWorkflowOperationReceipt(receipt);
            return receipt;
        });
    }

    async writeReceipt(
        ctx: Context,
        agentId: string,
        receipt: WorkflowOperationReceipt,
    ): Promise<void> {
        assertWorkflowOperationReceipt(receipt);
        await this.#read(ctx, "rig.sql.workflow.write_receipt", async (ctx) => {
            await ctx.tx
                .insert(workflowOperationReceipts)
                .values({
                    agentId,
                    operationId: receipt.operationId,
                    receiptJson: JSON.stringify(receipt),
                })
                .onConflictDoNothing()
                .run();
        });
    }

    async readMutationProof(
        ctx: Context,
        agentId: string,
        operationId: string,
    ): Promise<WorkflowMutationProof | undefined> {
        return await this.#read(ctx, "rig.sql.workflow.read_proof", async (ctx) => {
            const row = await ctx.tx
                .select({ value: workflowMutationProofs.proofJson })
                .from(workflowMutationProofs)
                .where(
                    and(
                        eq(workflowMutationProofs.agentId, agentId),
                        eq(workflowMutationProofs.operationId, operationId),
                    ),
                )
                .get();
            if (row === undefined) return undefined;
            const proof: unknown = JSON.parse(checked(jsonRowSchema, row, "workflow proof").value);
            assertWorkflowMutationProof(proof);
            return proof;
        });
    }

    async writeMutationProof(
        ctx: Context,
        agentId: string,
        proof: WorkflowMutationProof,
    ): Promise<void> {
        assertWorkflowMutationProof(proof);
        await this.#read(ctx, "rig.sql.workflow.write_proof", async (ctx) => {
            await ctx.tx
                .insert(workflowMutationProofs)
                .values({
                    agentId,
                    operationId: proof.operationId,
                    proofJson: JSON.stringify(proof),
                })
                .onConflictDoNothing()
                .run();
        });
    }

    /** Host runners append bounded log lines through this persistence port. */
    async appendLog(ctx: Context, agentId: string, id: string, text: string): Promise<void> {
        checked(
            Type.String({ maxLength: MAX_WORKFLOW_LOG_LINE_LENGTH }),
            text,
            "workflow log text",
        );
        await this.#read(ctx, "rig.sql.workflow.append_log", async (ctx) => {
            await this.#requireRunInScope(ctx, agentId, id);
            const raw: unknown = await ctx.tx
                .select({ count: sql<number>`count(*)` })
                .from(workflowLogs)
                .where(and(eq(workflowLogs.agentId, agentId), eq(workflowLogs.runId, id)))
                .get();
            const { count } = checked(countRowSchema, raw, "workflow log count");
            await ctx.tx
                .insert(workflowLogs)
                .values({ agentId, position: count, runId: id, text })
                .run();
        });
    }

    async #requireRun(ctx: Context, agentId: string, id: string): Promise<WorkflowRun> {
        const run = await this.get(ctx, agentId, id);
        if (run === undefined) throw new Error("Workflow run was not found.");
        return run;
    }

    async #requireRunInScope(ctx: Context, agentId: string, id: string): Promise<WorkflowRun> {
        const row = await ctx.tx
            .select({ value: workflowRuns.runJson })
            .from(workflowRuns)
            .where(and(eq(workflowRuns.agentId, agentId), eq(workflowRuns.id, id)))
            .get();
        if (row === undefined) throw new Error("Workflow run was not found.");
        return decodeRun(row);
    }

    async #writeRun(ctx: Context, run: WorkflowRun, mode: "insert" | "update"): Promise<void> {
        assertWorkflowRun(run);
        await this.#read(ctx, `rig.sql.workflow.${mode}`, async (ctx) => {
            const row = {
                agentId: run.agentId,
                createdAtMs: run.createdAt,
                id: run.id,
                runJson: JSON.stringify(run),
                status: run.status,
                updatedAtMs: run.updatedAt,
                workflow: run.workflow,
            };
            if (mode === "insert") {
                await ctx.tx.insert(workflowRuns).values(row).run();
                return;
            }
            const result = await ctx.tx
                .update(workflowRuns)
                .set(row)
                .where(and(eq(workflowRuns.agentId, run.agentId), eq(workflowRuns.id, run.id)))
                .run();
            if (result.rowsAffected !== 1) throw new Error("Workflow run was not found.");
        });
    }

    async #read<T>(
        ctx: Context,
        span: string,
        operation: (ctx: Context) => Promise<T>,
    ): Promise<T> {
        return await inDatabase(withDatabase(ctx, this.#database), span, operation);
    }
}

function decodeRun(row: unknown): WorkflowRun {
    const encoded = checked(jsonRowSchema, row, "workflow run").value;
    const run: unknown = JSON.parse(encoded);
    assertWorkflowRun(run);
    return run;
}

function checked<TSchema extends Parameters<typeof Value.Check>[0]>(
    schema: TSchema,
    value: unknown,
    label: string,
): Static<TSchema> {
    if (!Value.Check(schema, value)) throw new Error(`Stored ${label} is invalid.`);
    return value as Static<TSchema>;
}

function isTerminal(status: WorkflowRun["status"]): boolean {
    return (
        status === "completed" ||
        status === "failed" ||
        status === "cancelled" ||
        status === "unavailable"
    );
}
