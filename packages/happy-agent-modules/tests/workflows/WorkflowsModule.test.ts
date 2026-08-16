import { sql } from "drizzle-orm";
import { agentDatabaseRows } from "@slopus/happy-agent-base";
import { Value } from "@sinclair/typebox/value";
import { withLifetime } from "@steve.kite/stdlib";
import { describe, expect, it } from "vitest";

import * as WorkflowExports from "../../sources/workflows/index.js";
import {
    WorkflowsModule,
    workflowModuleOptionsSchema,
} from "../../sources/workflows/WorkflowsModule.js";
import {
    workflowLaunchToolInputSchema,
    workflowMutationResultSchema,
    workflowRunSchema,
    type WorkflowLaunchRequest,
    type WorkflowMutationRequest,
    type WorkflowMutationResult,
    type WorkflowRun,
} from "../../sources/workflows/Workflow.js";
import type { WorkflowRuntime } from "../../sources/workflows/WorkflowStore.js";
import { moduleDatabase } from "../support/moduleDatabase.js";

const OWNER = "agent-1";

function run(
    id: string,
    status: WorkflowRun["status"] = "queued",
    overrides: {
        readonly agentId?: string;
        readonly workflow?: string;
        readonly input?: string;
        readonly createdAt?: number;
        readonly updatedAt?: number;
        readonly startedAt?: number;
    } = {},
): WorkflowRun {
    const createdAt = overrides.createdAt ?? 1;
    const common = {
        id,
        agentId: overrides.agentId ?? OWNER,
        workflow: overrides.workflow ?? "demo",
        ...(overrides.input === undefined ? {} : { input: overrides.input }),
        createdAt,
    };
    if (status === "queued") {
        return { ...common, status, updatedAt: overrides.updatedAt ?? createdAt };
    }
    const startedAt = overrides.startedAt ?? createdAt;
    if (status === "running") {
        return { ...common, status, startedAt, updatedAt: overrides.updatedAt ?? startedAt };
    }
    if (status === "paused") {
        const updatedAt = overrides.updatedAt ?? 2;
        return { ...common, status, startedAt, pausedAt: updatedAt, updatedAt };
    }
    const updatedAt = overrides.updatedAt ?? 2;
    if (status === "completed") {
        return { ...common, status, startedAt, finishedAt: updatedAt, updatedAt };
    }
    if (status === "failed") {
        return {
            ...common,
            status,
            startedAt,
            finishedAt: updatedAt,
            error: "failed",
            updatedAt,
        };
    }
    if (status === "cancelled") {
        return { ...common, status, finishedAt: updatedAt, updatedAt };
    }
    return { ...common, status, finishedAt: updatedAt, updatedAt };
}

function workflowTest(name: string) {
    const runtimeRuns = new Map<string, WorkflowRun>();
    const launchRequests: WorkflowLaunchRequest[] = [];
    const mutationRequests: WorkflowMutationRequest[] = [];
    const runtimeDatabases: unknown[] = [];
    let database!: ReturnType<typeof moduleDatabase>;

    const runtime: WorkflowRuntime = {
        launch: async (ctx, agentId, request) => {
            runtimeDatabases.push(ctx.db);
            launchRequests.push(structuredClone(request));
            const created = run(request.operationId, "queued", {
                agentId,
                workflow: request.workflow,
                ...(request.input === undefined ? {} : { input: request.input }),
            });
            runtimeRuns.set(created.id, created);
            return created;
        },
        cancel: async (ctx, agentId, request) => {
            runtimeDatabases.push(ctx.db);
            mutationRequests.push(structuredClone(request));
            const current = runtimeRuns.get(request.id);
            if (current === undefined) throw new Error("runtime run missing");
            const cancelled = run(current.id, "cancelled", {
                agentId,
                workflow: current.workflow,
                ...(current.input === undefined ? {} : { input: current.input }),
                createdAt: current.createdAt,
                updatedAt: current.updatedAt + 1,
            });
            runtimeRuns.set(cancelled.id, cancelled);
            return {
                agentId,
                operationId: request.operationId,
                run: cancelled,
                changed: true,
            };
        },
        resume: async (ctx, agentId, request) => {
            runtimeDatabases.push(ctx.db);
            mutationRequests.push(structuredClone(request));
            const current = runtimeRuns.get(request.id);
            if (current?.status !== "paused") throw new Error("runtime run is not paused");
            const resumed = run(current.id, "running", {
                agentId,
                workflow: current.workflow,
                ...(current.input === undefined ? {} : { input: current.input }),
                createdAt: current.createdAt,
                startedAt: current.startedAt,
                updatedAt: current.updatedAt + 1,
            });
            runtimeRuns.set(resumed.id, resumed);
            return {
                agentId,
                operationId: request.operationId,
                run: resumed,
                changed: true,
            };
        },
        wait: async (ctx, agentId, id) => {
            runtimeDatabases.push(ctx.db);
            return runtimeRuns.get(id) ?? run(id, "unavailable", { agentId });
        },
    };
    const module = new WorkflowsModule({
        runtime,
        idFactory: () => "public-operation",
        eventIdFactory: () => "event-1",
        clock: () => 10,
    });
    database = moduleDatabase(module.migrations, name);
    return {
        database,
        module,
        runtimeRuns,
        launchRequests,
        mutationRequests,
        runtimeDatabases,
    };
}

function toolCall(id: string): never {
    return {
        id,
        providerCallId: `provider-${id}`,
    } as never;
}

describe("WorkflowsModule", () => {
    it("exports the current workflow surface without replay schemas", () => {
        expect(WorkflowExports.WorkflowsModule).toBe(WorkflowsModule);
        expect(WorkflowExports.workflowModuleOptionsSchema).toBe(workflowModuleOptionsSchema);
        expect(WorkflowExports.workflowRunSchema).toBe(workflowRunSchema);
        expect(WorkflowExports.workflowObservedRunSchema).toBeDefined();
        expect(WorkflowExports.workflowMutationResultSchema).toBe(workflowMutationResultSchema);
        expect("workflowCallOperationSchema" in WorkflowExports).toBe(false);
        expect("workflowOperationReceiptSchema" in WorkflowExports).toBe(false);
        expect("workflowMutationProofSchema" in WorkflowExports).toBe(false);
        expect(
            Value.Check(workflowModuleOptionsSchema, {
                runtime: {
                    launch: async () => run("run"),
                    cancel: async () => ({
                        agentId: OWNER,
                        operationId: "operation",
                        run: run("run"),
                        changed: false,
                    }),
                    resume: async () => ({
                        agentId: OWNER,
                        operationId: "operation",
                        run: run("run"),
                        changed: false,
                    }),
                    wait: async () => run("run", "completed"),
                },
            }),
        ).toBe(true);
    });

    it("adds a forward migration that drops the obsolete receipt and proof tables", async () => {
        const test = workflowTest("workflow-migrations");
        await test.database.ready;
        try {
            expect(test.module.migrations.map(([key]) => key)).toEqual([
                "001-workflows-runs",
                "002-workflows-drop-replay-evidence",
            ]);
            await test.module.migrations[1]![1](test.database.context, test.database.database);
            const tables = await agentDatabaseRows<{ name: string }>(
                test.database.database,
                sql`SELECT name FROM sqlite_master
                    WHERE type = 'table' AND name LIKE 'happy_agent_module_workflow_%'
                    ORDER BY name`,
            );
            expect(tables.map(({ name }) => name)).toEqual([
                "happy_agent_module_workflow_logs",
                "happy_agent_module_workflow_runs",
            ]);
        } finally {
            test.database.close();
        }
    });

    it("uses call.id as the launch identity without a custom tool commit", async () => {
        const test = workflowTest("workflow-launch-tool");
        await test.database.ready;
        try {
            const tool = test.module
                .tools(test.database.context, { agent: { id: OWNER } } as never)
                .find(({ name }) => name === "run_workflow");
            expect(tool).toBeDefined();
            const result = await tool!.execute(
                test.database.context,
                { workflow: "demo", input: "one\r\ntwo" },
                toolCall("call-cuid2"),
            );

            expect(result.id).toBe("call-cuid2");
            expect(test.launchRequests).toEqual([
                { workflow: "demo", input: "one\ntwo", operationId: "call-cuid2" },
            ]);
            expect(test.runtimeDatabases).toEqual([test.database.database]);
            await expect(
                test.module.status(test.database.context, OWNER, "call-cuid2"),
            ).resolves.toEqual(result);
        } finally {
            test.database.close();
        }
    });

    it("accepts bounded script orchestration inputs and forwards them to the host", async () => {
        const test = workflowTest("workflow-script-launch");
        await test.database.ready;
        try {
            const tool = test.module
                .tools(test.database.context, { agent: { id: OWNER } } as never)
                .find(({ name }) => name === "run_workflow");
            expect(tool).toBeDefined();
            await tool!.execute(
                test.database.context,
                {
                    script: "print('review')\r\n",
                    args: { files: ["a.ts", "b.ts"] },
                    name: "review",
                    description: "Review changed files",
                    resumeFromRunId: "prior-run",
                },
                toolCall("script-call"),
            );

            expect(test.launchRequests).toEqual([
                {
                    workflow: "review",
                    script: "print('review')\n",
                    args: { files: ["a.ts", "b.ts"] },
                    name: "review",
                    description: "Review changed files",
                    resumeFromRunId: "prior-run",
                    operationId: "script-call",
                },
            ]);
            expect(
                Value.Check(workflowLaunchToolInputSchema, {
                    scriptPath: "workflows/review.py",
                    args: null,
                }),
            ).toBe(true);
            expect(
                Value.Check(workflowLaunchToolInputSchema, {
                    script: "one",
                    scriptPath: "two.py",
                }),
            ).toBe(false);
        } finally {
            test.database.close();
        }
    });

    it("includes accumulated logs, agent count, and a legacy status projection", async () => {
        const test = workflowTest("workflow-observations");
        await test.database.ready;
        try {
            await test.module.launch(test.database.context, OWNER, {
                workflow: "demo",
                operationId: "run-1",
            });
            test.runtimeRuns.set("run-1", {
                ...run("run-1", "completed", { updatedAt: 3, startedAt: 1 }),
                agentCount: 3,
                logs: ["phase one", "phase two"],
                logsTruncated: false,
            });

            const result = await test.module.wait(test.database.context, OWNER, "run-1");
            expect(result).toMatchObject({
                agentCount: 3,
                logs: ["phase one", "phase two"],
                logsTruncated: false,
                legacyStatus: "completed",
            });
            await expect(
                test.module.status(test.database.context, OWNER, "run-1"),
            ).resolves.toMatchObject({
                agentCount: 3,
                logs: ["phase one", "phase two"],
                legacyStatus: "completed",
            });
            expect(test.module.formatRunForModel(result)).toContain("agent_count: 3");
            expect(test.module.formatRunForModel(result)).toContain("phase one");
        } finally {
            test.database.close();
        }
    });

    it("marks model-facing accumulated logs when the character budget truncates them", async () => {
        const test = workflowTest("workflow-log-formatting");
        await test.database.ready;
        try {
            const text = test.module.formatRunForModel({
                ...run("run-1", "completed", { updatedAt: 2 }),
                agentCount: 2,
                logs: Array.from({ length: 10 }, () => "x".repeat(4_000)),
            });
            expect(text.length).toBeLessThanOrEqual(12_000);
            expect(text).toContain("logs_truncated: true");
        } finally {
            test.database.close();
        }
    });

    it("cancels only the wait when the calling lifetime is aborted", async () => {
        let release!: (value: WorkflowRun) => void;
        let receivedSignal: AbortSignal | undefined;
        const module = new WorkflowsModule({
            runtime: {
                launch: async () => run("unused"),
                cancel: async () => ({
                    agentId: OWNER,
                    operationId: "cancel",
                    run: run("run-1", "cancelled", { updatedAt: 2 }),
                    changed: true,
                }),
                resume: async () => ({
                    agentId: OWNER,
                    operationId: "resume",
                    run: run("run-1", "running"),
                    changed: true,
                }),
                wait: async (_ctx, _agentId, _id, signal) => {
                    receivedSignal = signal;
                    return await new Promise<WorkflowRun>((resolve) => {
                        release = resolve;
                    });
                },
            },
        });
        const database = moduleDatabase(module.migrations, "workflow-wait-cancel");
        await database.ready;
        const controller = new AbortController();
        try {
            const pending = module.wait(
                withLifetime(database.context, controller.signal),
                OWNER,
                "run-1",
            );
            await Promise.resolve();
            controller.abort();
            await expect(pending).rejects.toThrow(
                "Workflow wait was cancelled; the workflow continues running in the background.",
            );
            expect(receivedSignal).toBe(controller.signal);
            release(run("run-1", "completed", { updatedAt: 2 }));
        } finally {
            database.close();
        }
    });

    it("marks database reads transactional and host-runtime tools non-durable", async () => {
        const test = workflowTest("workflow-tool-contracts");
        await test.database.ready;
        try {
            const tools = test.module.tools(test.database.context, {
                agent: { id: OWNER },
            } as never);
            for (const name of ["list_workflows", "workflow_status", "workflow_logs"]) {
                const tool = tools.find((candidate) => candidate.name === name);
                expect(tool).toMatchObject({ durable: true, transactional: true });
            }
            for (const name of [
                "run_workflow",
                "cancel_workflow",
                "resume_workflow",
                "wait_workflow",
            ]) {
                const tool = tools.find((candidate) => candidate.name === name);
                expect(tool).toMatchObject({ durable: false });
                expect(tool?.transactional).toBeUndefined();
            }
            expect(
                tools.find((candidate) => candidate.name === "run_workflow")?.description,
            ).toContain("Only use this when the user explicitly asks");
            expect(
                tools.find((candidate) => candidate.name === "wait_workflow")?.description,
            ).toContain("only this wait is cancelled");
        } finally {
            test.database.close();
        }
    });

    it("uses call.id for cancellation without holding a runtime transaction", async () => {
        const test = workflowTest("workflow-cancel-tool");
        await test.database.ready;
        try {
            await test.module.launch(test.database.context, OWNER, {
                workflow: "demo",
                operationId: "run-1",
            });
            const tool = test.module
                .tools(test.database.context, { agent: { id: OWNER } } as never)
                .find(({ name }) => name === "cancel_workflow");
            const result = await tool!.execute(
                test.database.context,
                { id: "run-1" },
                toolCall("cancel-cuid2"),
            );

            expect(result).toMatchObject({
                agentId: OWNER,
                operationId: "cancel-cuid2",
                changed: true,
                run: { id: "run-1", status: "cancelled" },
            });
            expect(test.mutationRequests).toEqual([{ id: "run-1", operationId: "cancel-cuid2" }]);
            expect(test.runtimeDatabases.at(-1)).toBe(test.database.database);
        } finally {
            test.database.close();
        }
    });

    it("does not replay duplicate public operation IDs", async () => {
        const test = workflowTest("workflow-no-replay");
        await test.database.ready;
        try {
            await test.module.launch(test.database.context, OWNER, {
                workflow: "demo",
                operationId: "run-1",
            });
            await expect(
                test.module.launch(test.database.context, OWNER, {
                    workflow: "demo",
                    operationId: "run-1",
                }),
            ).rejects.toThrow('Workflow run "run-1" already exists.');
            expect(test.launchRequests).toHaveLength(1);
        } finally {
            test.database.close();
        }
    });

    it("waits outside a transaction, then persists the completion", async () => {
        const test = workflowTest("workflow-wait-tool");
        await test.database.ready;
        try {
            await test.module.launch(test.database.context, OWNER, {
                workflow: "demo",
                operationId: "run-1",
            });
            test.runtimeRuns.set(
                "run-1",
                run("run-1", "completed", { updatedAt: 3, startedAt: 1 }),
            );
            const tool = test.module
                .tools(test.database.context, { agent: { id: OWNER } } as never)
                .find(({ name }) => name === "wait_workflow");
            const result = await tool!.execute(
                test.database.context,
                { id: "run-1" },
                toolCall("wait-cuid2"),
            );

            expect(result.status).toBe("completed");
            expect(test.runtimeDatabases.at(-1)).toBe(test.database.database);
            await expect(
                test.module.status(test.database.context, OWNER, "run-1"),
            ).resolves.toEqual(result);

            const unavailable = await test.module.wait(test.database.context, OWNER, "missing-run");
            expect(unavailable.status).toBe("unavailable");
            await expect(
                test.module.status(test.database.context, OWNER, "missing-run"),
            ).resolves.toEqual(unavailable);
        } finally {
            test.database.close();
        }
    });

    it("keeps bounded reads and model formatting", async () => {
        const test = workflowTest("workflow-reads");
        await test.database.ready;
        try {
            await test.module.launch(test.database.context, OWNER, {
                workflow: "demo",
                operationId: "run-1",
            });
            const page = await test.module.list(test.database.context, OWNER, {
                cursor: 0,
                limit: 10,
            });
            expect(page.runs.map(({ id }) => id)).toEqual(["run-1"]);
            expect(test.module.formatPageForModel(page)).toBe("run-1: demo [queued]");
            expect(test.module.formatRunForModel(page.runs[0]!)).toContain("status: queued");
            await expect(
                test.module.logs(test.database.context, OWNER, { id: "run-1" }),
            ).resolves.toMatchObject({
                agentId: OWNER,
                id: "run-1",
                lines: [],
            });
        } finally {
            test.database.close();
        }
    });

    it("validates runtime ownership before committing state", async () => {
        let database!: ReturnType<typeof moduleDatabase>;
        const module = new WorkflowsModule({
            runtime: {
                launch: async (_ctx, _agentId, request) =>
                    run(request.operationId, "queued", { agentId: "another-agent" }),
                cancel: async () => {
                    throw new Error("unused");
                },
                resume: async () => {
                    throw new Error("unused");
                },
                wait: async (_ctx, _agentId, id) =>
                    run(id, "unavailable", { agentId: "another-agent" }),
            },
        });
        database = moduleDatabase(module.migrations, "workflow-ownership");
        await database.ready;
        try {
            await expect(
                module.launch(database.context, OWNER, {
                    workflow: "demo",
                    operationId: "run-1",
                }),
            ).rejects.toThrow("unrelated launch");
            await expect(module.status(database.context, OWNER, "run-1")).resolves.toBeUndefined();
        } finally {
            database.close();
        }
    });
});
