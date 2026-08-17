import { sql } from "drizzle-orm";
import { agentDatabaseRun } from "@slopus/happy-agent-base";
import { Value } from "@sinclair/typebox/value";
import { withLifetime } from "@steve.kite/stdlib";
import { describe, expect, it } from "vitest";

import {
    MAX_WORKFLOW_AGENT_ID_LENGTH,
    MAX_WORKFLOW_ARGS_BYTES,
    MAX_WORKFLOW_ARGS_DEPTH,
    MAX_WORKFLOW_ARGS_ITEMS,
    MAX_WORKFLOW_ARGS_KEY_LENGTH,
    MAX_WORKFLOW_ARGS_PROPERTIES,
    MAX_WORKFLOW_ARGS_STRING_LENGTH,
    MAX_WORKFLOW_ID_LENGTH,
    MAX_WORKFLOW_INPUT_LENGTH,
    MAX_WORKFLOW_LOG_LINE_LENGTH,
    MAX_WORKFLOW_LOG_LINES,
    MAX_WORKFLOW_NAME_LENGTH,
    MAX_WORKFLOW_OUTPUT_CHARACTERS,
    MAX_WORKFLOW_PAGE_SIZE,
    MAX_WORKFLOW_SCRIPT_LENGTH,
    MAX_WORKFLOW_SCRIPT_PATH_LENGTH,
    WorkflowsModule,
    assertWorkflowLogPage,
    assertWorkflowMutationResult,
    assertWorkflowRun,
    workflowAgentIdSchema,
    workflowArgsSchema,
    workflowEventSchema,
    workflowLaunchInputSchema,
    workflowMutationResultSchema,
    workflowRunSchema,
    workflowRuntimeSchema,
    workflowStatusSchema,
    type WorkflowEvent,
    type WorkflowLaunchRequest,
    type WorkflowMutationRequest,
    type WorkflowMutationResult,
    type WorkflowRun,
    type WorkflowRuntime,
} from "../../sources/workflows/index.js";
import {
    WORKFLOW_LOGS_TABLE,
    WORKFLOW_RUNS_TABLE,
} from "../../sources/workflows/WorkflowDatabase.js";
import { moduleDatabase } from "../support/moduleDatabase.js";
import { resolveModuleHooks } from "../support/moduleHooks.js";

const OWNER = "workflow-owner";
const OTHER_OWNER = "other-owner";

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
        readonly output?: string;
        readonly error?: string;
        readonly agentCount?: number;
        readonly logs?: string[];
        readonly logsTruncated?: boolean;
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
        return {
            ...common,
            status,
            updatedAt: overrides.updatedAt ?? createdAt,
            ...(overrides.agentCount === undefined ? {} : { agentCount: overrides.agentCount }),
            ...(overrides.logs === undefined ? {} : { logs: overrides.logs }),
            ...(overrides.logsTruncated === undefined
                ? {}
                : { logsTruncated: overrides.logsTruncated }),
        };
    }
    const startedAt = overrides.startedAt ?? createdAt;
    if (status === "running") {
        return {
            ...common,
            status,
            startedAt,
            updatedAt: overrides.updatedAt ?? startedAt,
            ...(overrides.output === undefined ? {} : { output: overrides.output }),
            ...(overrides.agentCount === undefined ? {} : { agentCount: overrides.agentCount }),
            ...(overrides.logs === undefined ? {} : { logs: overrides.logs }),
            ...(overrides.logsTruncated === undefined
                ? {}
                : { logsTruncated: overrides.logsTruncated }),
        };
    }
    if (status === "paused") {
        const updatedAt = overrides.updatedAt ?? 2;
        return {
            ...common,
            status,
            startedAt,
            pausedAt: updatedAt,
            updatedAt,
            ...(overrides.output === undefined ? {} : { output: overrides.output }),
            ...(overrides.agentCount === undefined ? {} : { agentCount: overrides.agentCount }),
            ...(overrides.logs === undefined ? {} : { logs: overrides.logs }),
            ...(overrides.logsTruncated === undefined
                ? {}
                : { logsTruncated: overrides.logsTruncated }),
        };
    }
    const updatedAt = overrides.updatedAt ?? 2;
    if (status === "failed") {
        return {
            ...common,
            status,
            startedAt,
            finishedAt: updatedAt,
            error: overrides.error ?? "failed",
            updatedAt,
            ...(overrides.output === undefined ? {} : { output: overrides.output }),
            ...(overrides.agentCount === undefined ? {} : { agentCount: overrides.agentCount }),
            ...(overrides.logs === undefined ? {} : { logs: overrides.logs }),
            ...(overrides.logsTruncated === undefined
                ? {}
                : { logsTruncated: overrides.logsTruncated }),
        };
    }
    if (status === "completed") {
        return {
            ...common,
            status,
            startedAt,
            finishedAt: updatedAt,
            updatedAt,
            ...(overrides.output === undefined ? {} : { output: overrides.output }),
            ...(overrides.agentCount === undefined ? {} : { agentCount: overrides.agentCount }),
            ...(overrides.logs === undefined ? {} : { logs: overrides.logs }),
            ...(overrides.logsTruncated === undefined
                ? {}
                : { logsTruncated: overrides.logsTruncated }),
        };
    }
    if (status === "cancelled") {
        return {
            ...common,
            status,
            finishedAt: updatedAt,
            updatedAt,
            ...(overrides.output === undefined ? {} : { output: overrides.output }),
            ...(overrides.agentCount === undefined ? {} : { agentCount: overrides.agentCount }),
            ...(overrides.logs === undefined ? {} : { logs: overrides.logs }),
            ...(overrides.logsTruncated === undefined
                ? {}
                : { logsTruncated: overrides.logsTruncated }),
        };
    }
    return {
        ...common,
        status,
        finishedAt: updatedAt,
        updatedAt,
        ...(overrides.output === undefined ? {} : { output: overrides.output }),
        ...(overrides.error === undefined ? {} : { error: overrides.error }),
        ...(overrides.agentCount === undefined ? {} : { agentCount: overrides.agentCount }),
        ...(overrides.logs === undefined ? {} : { logs: overrides.logs }),
        ...(overrides.logsTruncated === undefined
            ? {}
            : { logsTruncated: overrides.logsTruncated }),
    };
}

interface Harness {
    readonly module: WorkflowsModule;
    readonly database: ReturnType<typeof moduleDatabase>;
    readonly runtime: WorkflowRuntime;
    readonly runtimeRuns: Map<string, WorkflowRun>;
    readonly launchRequests: WorkflowLaunchRequest[];
    readonly mutationRequests: WorkflowMutationRequest[];
    readonly runtimeDatabases: unknown[];
}

async function harness(
    name: string,
    options: {
        readonly runtime?: Partial<WorkflowRuntime>;
        readonly module?: Partial<ConstructorParameters<typeof WorkflowsModule>[0]>;
    } = {},
): Promise<Harness> {
    const runtimeRuns = new Map<string, WorkflowRun>();
    const launchRequests: WorkflowLaunchRequest[] = [];
    const mutationRequests: WorkflowMutationRequest[] = [];
    const runtimeDatabases: unknown[] = [];
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
                ...("output" in current && current.output !== undefined
                    ? { output: current.output }
                    : {}),
                ...(current.agentCount === undefined ? {} : { agentCount: current.agentCount }),
                ...(current.logs === undefined ? {} : { logs: current.logs }),
                ...(current.logsTruncated === undefined
                    ? {}
                    : { logsTruncated: current.logsTruncated }),
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
                ...("output" in current && current.output !== undefined
                    ? { output: current.output }
                    : {}),
                ...(current.agentCount === undefined ? {} : { agentCount: current.agentCount }),
                ...(current.logs === undefined ? {} : { logs: current.logs }),
                ...(current.logsTruncated === undefined
                    ? {}
                    : { logsTruncated: current.logsTruncated }),
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
        ...options.runtime,
    };
    const module = new WorkflowsModule({
        runtime,
        idFactory: () => "generated-operation",
        eventIdFactory: () => "generated-event",
        clock: () => 10,
        ...options.module,
    });
    const database = moduleDatabase(module.migrations, name);
    await database.ready;
    return {
        module,
        database,
        runtime,
        runtimeRuns,
        launchRequests,
        mutationRequests,
        runtimeDatabases,
    };
}

async function insertRun(
    database: ReturnType<typeof moduleDatabase>,
    value: unknown,
    agentId = OWNER,
    id = "stored-run",
): Promise<void> {
    const runValue = value as { readonly workflow?: string; readonly status?: string };
    await agentDatabaseRun(
        database.database,
        sql`INSERT INTO ${sql.raw(WORKFLOW_RUNS_TABLE)}
            (agent_id, id, workflow, status, created_at, updated_at, run_json)
            VALUES (${agentId}, ${id}, ${runValue.workflow ?? "demo"}, ${
                runValue.status ?? "queued"
            }, 1, 1, ${JSON.stringify(value)})`,
    );
}

async function insertLog(
    database: ReturnType<typeof moduleDatabase>,
    runId: string,
    position: number,
    text: string,
    agentId = OWNER,
): Promise<void> {
    await agentDatabaseRun(
        database.database,
        sql`INSERT INTO ${sql.raw(WORKFLOW_LOGS_TABLE)}
            (agent_id, run_id, position, text)
            VALUES (${agentId}, ${runId}, ${position}, ${text})`,
    );
}

function toolCall(id: string): never {
    return { id, providerCallId: `provider-${id}` } as never;
}

describe("WorkflowsModule edge contracts", () => {
    it("enforces identity, state, and recursive argument bounds", () => {
        const maxId = `a${"x".repeat(MAX_WORKFLOW_ID_LENGTH - 1)}`;
        const maxAgent = `a${"x".repeat(MAX_WORKFLOW_AGENT_ID_LENGTH - 1)}`;
        const maxName = `a${"x".repeat(MAX_WORKFLOW_NAME_LENGTH - 1)}`;
        expect(Value.Check(workflowAgentIdSchema, maxAgent)).toBe(true);
        expect(Value.Check(workflowRunSchema, run(maxId, "queued", { workflow: maxName }))).toBe(
            true,
        );
        for (const invalid of ["", "\0bad", "line\nbreak", "line\rbreak", `${maxAgent}x`]) {
            expect(Value.Check(workflowAgentIdSchema, invalid)).toBe(false);
        }
        expect(Value.Check(workflowStatusSchema, "not-a-status")).toBe(false);
        expect(
            Value.Check(workflowLaunchInputSchema, {
                workflow: "demo",
                operationId: maxId,
                unexpected: true,
            }),
        ).toBe(false);
        expect(
            Value.Check(workflowArgsSchema, {
                key: "x".repeat(MAX_WORKFLOW_ARGS_STRING_LENGTH),
            }),
        ).toBe(true);
        expect(
            Value.Check(workflowArgsSchema, {
                ["x".repeat(MAX_WORKFLOW_ARGS_KEY_LENGTH)]: null,
            }),
        ).toBe(true);
        expect(
            Value.Check(workflowArgsSchema, {
                items: Array.from({ length: MAX_WORKFLOW_ARGS_ITEMS }, () => null),
            }),
        ).toBe(true);
        expect(
            Value.Check(workflowArgsSchema, {
                items: Array.from({ length: MAX_WORKFLOW_ARGS_ITEMS + 1 }, () => null),
            }),
        ).toBe(false);
        expect(
            Value.Check(
                workflowArgsSchema,
                Object.fromEntries(
                    Array.from({ length: MAX_WORKFLOW_ARGS_PROPERTIES }, (_, index) => [
                        `key-${index}`,
                        null,
                    ]),
                ),
            ),
        ).toBe(true);
        expect(
            Value.Check(
                workflowArgsSchema,
                Object.fromEntries(
                    Array.from({ length: MAX_WORKFLOW_ARGS_PROPERTIES + 1 }, (_, index) => [
                        `key-${index}`,
                        null,
                    ]),
                ),
            ),
        ).toBe(false);
        let nested: unknown = null;
        for (let depth = 0; depth < MAX_WORKFLOW_ARGS_DEPTH; depth += 1) nested = { nested };
        expect(Value.Check(workflowArgsSchema, nested)).toBe(true);
        nested = { nested };
        expect(Value.Check(workflowArgsSchema, nested)).toBe(false);
        expect(Value.Check(workflowArgsSchema, Number.NaN)).toBe(false);
        expect(Value.Check(workflowArgsSchema, Number.POSITIVE_INFINITY)).toBe(false);
        expect(MAX_WORKFLOW_ARGS_BYTES).toBeGreaterThan(0);
        expect(MAX_WORKFLOW_INPUT_LENGTH).toBeGreaterThan(MAX_WORKFLOW_SCRIPT_LENGTH / 30);
        expect(MAX_WORKFLOW_SCRIPT_PATH_LENGTH).toBeGreaterThan(0);
        expect(MAX_WORKFLOW_PAGE_SIZE).toBeGreaterThan(0);
        expect(MAX_WORKFLOW_LOG_LINES).toBeGreaterThan(0);
        expect(MAX_WORKFLOW_LOG_LINE_LENGTH).toBeGreaterThan(0);
        expect(MAX_WORKFLOW_OUTPUT_CHARACTERS).toBeGreaterThan(0);
    });

    it("rejects argument object keys longer than the declared bound", () => {
        expect(
            Value.Check(workflowArgsSchema, {
                ["x".repeat(MAX_WORKFLOW_ARGS_KEY_LENGTH + 1)]: null,
            }),
        ).toBe(false);
    });

    it("rejects every invalid persisted lifecycle invariant", () => {
        const cases: unknown[] = [
            { ...run("bad"), updatedAt: 0 },
            { ...run("bad", "running"), startedAt: 0 },
            { ...run("bad", "running"), startedAt: 3, updatedAt: 2 },
            { ...run("bad", "paused"), pausedAt: 1 },
            { ...run("bad", "completed"), finishedAt: 1 },
            { ...run("bad", "failed"), finishedAt: 1 },
            { ...run("bad", "cancelled"), finishedAt: 1 },
            { ...run("bad", "unavailable"), finishedAt: 1 },
            { ...run("bad", "completed"), legacyStatus: "running" },
            { ...run("bad", "completed"), extra: true },
        ];
        for (const value of cases) expect(() => assertWorkflowRun(value)).toThrow();
        expect(() => assertWorkflowMutationResult({ nope: true })).toThrow();
        expect(() => assertWorkflowLogPage({ nope: true })).toThrow();
    });

    it("rejects malformed constructor options and hides all tools when disabled", async () => {
        const runtime: WorkflowRuntime = {
            launch: async () => run("run"),
            cancel: async () => ({
                agentId: OWNER,
                operationId: "op",
                run: run("run"),
                changed: false,
            }),
            resume: async () => ({
                agentId: OWNER,
                operationId: "op",
                run: run("run"),
                changed: false,
            }),
            wait: async () => run("run", "completed"),
        };
        expect(() => new WorkflowsModule({ runtime, unexpected: true } as never)).toThrow();
        expect(() => new WorkflowsModule({ runtime, maxPageSize: 0 })).toThrow();
        expect(() => new WorkflowsModule({ runtime, maxOutputCharacters: 255 })).toThrow();
        expect(Value.Check(workflowRuntimeSchema, { ...runtime, extra: true })).toBe(false);
        const module = new WorkflowsModule({ runtime, enabled: false });
        const database = moduleDatabase(module.migrations, "workflow-disabled");
        await database.ready;
        try {
            const hooks = await resolveModuleHooks(database.context, module);
            expect(
                await hooks.tools?.(database.context, { agent: { id: OWNER } } as never),
            ).toEqual([]);
            await expect(module.status(database.context, OWNER, "run")).rejects.toThrow("disabled");
        } finally {
            database.close();
        }
    });

    it("exposes exactly the common workflow tools with the documented durability split", async () => {
        const test = await harness("workflow-tool-surface");
        try {
            const hooks = await resolveModuleHooks(test.database.context, test.module);
            const tools = await hooks.tools!(test.database.context, {
                agent: { id: OWNER },
            } as never);
            expect(tools.map(({ name }) => name)).toEqual([
                "run_workflow",
                "list_workflows",
                "workflow_status",
                "cancel_workflow",
                "resume_workflow",
                "wait_workflow",
                "workflow_logs",
            ]);
            expect(
                tools
                    .filter(({ name }) =>
                        ["list_workflows", "workflow_status", "workflow_logs"].includes(name),
                    )
                    .every((tool) => tool.durable === true && tool.transactional === true),
            ).toBe(true);
            expect(
                tools
                    .filter(({ name }) =>
                        [
                            "run_workflow",
                            "cancel_workflow",
                            "resume_workflow",
                            "wait_workflow",
                        ].includes(name),
                    )
                    .every((tool) => tool.durable === false && tool.transactional === undefined),
            ).toBe(true);
        } finally {
            test.database.close();
        }
    });

    it("normalizes line endings, script names, descriptions, and clones script args", async () => {
        const test = await harness("workflow-normalization");
        try {
            const originalArgs = { files: ["one.ts"] };
            await test.module.launch(test.database.context, OWNER, {
                scriptPath: "nested/review.PY",
                args: originalArgs,
                name: "  review  ",
                description: "  inspect files  ",
                operationId: "normalization",
            });
            originalArgs.files.push("mutated.ts");
            expect(test.launchRequests).toEqual([
                {
                    workflow: "review",
                    scriptPath: "nested/review.PY",
                    args: { files: ["one.ts"] },
                    name: "review",
                    description: "inspect files",
                    operationId: "normalization",
                },
            ]);
            await test.module.launch(test.database.context, OWNER, {
                script: "a\r\nb\rc",
                operationId: "script-normalization",
            });
            expect(test.launchRequests.at(-1)).toMatchObject({
                workflow: "dynamic-workflow",
                script: "a\nb\nc",
                description: "Run dynamic-workflow",
            });
            await test.module.launch(test.database.context, OWNER, {
                workflow: "named",
                input: "a\r\nb\rc",
                operationId: "input-normalization",
            });
            expect(test.launchRequests.at(-1)).toEqual({
                workflow: "named",
                input: "a\nb\nc",
                operationId: "input-normalization",
            });
        } finally {
            test.database.close();
        }
    });

    it("enforces encoded argument bytes and exact script/input/path bounds before host launch", async () => {
        const test = await harness("workflow-input-bounds");
        try {
            const oversizedArgs = Object.fromEntries(
                Array.from({ length: 40 }, (_, index) => [
                    `key-${index}`,
                    "x".repeat(MAX_WORKFLOW_ARGS_STRING_LENGTH),
                ]),
            );
            await expect(
                test.module.launch(test.database.context, OWNER, {
                    script: "print('too large')",
                    args: oversizedArgs,
                    operationId: "oversized-args",
                }),
            ).rejects.toThrow("encoded-byte bound");
            expect(test.launchRequests).toHaveLength(0);
            expect(
                Value.Check(workflowLaunchInputSchema, {
                    script: "x".repeat(MAX_WORKFLOW_SCRIPT_LENGTH),
                    operationId: "not-tool-input",
                }),
            ).toBe(true);
            expect(
                Value.Check(workflowLaunchInputSchema, {
                    script: "x".repeat(MAX_WORKFLOW_SCRIPT_LENGTH + 1),
                    operationId: "not-tool-input",
                }),
            ).toBe(false);
            expect(
                Value.Check(workflowLaunchInputSchema, {
                    scriptPath: "x".repeat(MAX_WORKFLOW_SCRIPT_PATH_LENGTH),
                    operationId: "not-tool-input",
                }),
            ).toBe(true);
            expect(
                Value.Check(workflowLaunchInputSchema, {
                    scriptPath: "x".repeat(MAX_WORKFLOW_SCRIPT_PATH_LENGTH + 1),
                    operationId: "not-tool-input",
                }),
            ).toBe(false);
            expect(
                Value.Check(workflowLaunchInputSchema, {
                    workflow: "demo",
                    input: "x".repeat(MAX_WORKFLOW_INPUT_LENGTH),
                    operationId: "not-tool-input",
                }),
            ).toBe(true);
            expect(
                Value.Check(workflowLaunchInputSchema, {
                    workflow: "demo",
                    input: "x".repeat(MAX_WORKFLOW_INPUT_LENGTH + 1),
                    operationId: "not-tool-input",
                }),
            ).toBe(false);
        } finally {
            test.database.close();
        }
    });

    it("preserves generated and tool-owned operation identities without accepting model IDs", async () => {
        let factoryCalls = 0;
        const test = await harness("workflow-operation-identities", {
            module: {
                idFactory: () => `generated-${++factoryCalls}`,
            },
        });
        try {
            const generated = await test.module.launch(test.database.context, OWNER, {
                workflow: "demo",
            });
            expect(generated.id).toBe("generated-1");
            const hooks = await resolveModuleHooks(test.database.context, test.module);
            const tool = (
                await hooks.tools!(test.database.context, {
                    agent: { id: OWNER },
                } as never)
            ).find((candidate) => candidate.name === "run_workflow");
            expect(tool).toBeDefined();
            await tool!.execute(
                test.database.context,
                { input: { workflow: "demo" } },
                toolCall("tool-call-id"),
            );
            expect(test.launchRequests.at(-1)?.operationId).toBe("tool-call-id");
            expect(
                Value.Check(workflowLaunchInputSchema, {
                    workflow: "demo",
                    operationId: "model-supplied",
                }),
            ).toBe(true);
            expect(
                Value.Check(workflowLaunchInputSchema, {
                    workflow: "demo",
                    operationId: "",
                }),
            ).toBe(false);
        } finally {
            test.database.close();
        }
    });

    it("rejects malformed runtime launch, wait, and mutation identities before persistence", async () => {
        const launchTest = await harness("workflow-runtime-launch-validation", {
            runtime: {
                launch: async (_ctx, _agentId, request) =>
                    run(request.operationId, "queued", { agentId: OTHER_OWNER }),
            },
        });
        try {
            await expect(
                launchTest.module.launch(launchTest.database.context, OWNER, {
                    workflow: "demo",
                    operationId: "wrong-owner",
                }),
            ).rejects.toThrow("unrelated launch");
            await expect(
                launchTest.module.status(launchTest.database.context, OWNER, "wrong-owner"),
            ).resolves.toBeUndefined();
        } finally {
            launchTest.database.close();
        }

        const waitTest = await harness("workflow-runtime-wait-validation", {
            runtime: {
                wait: async (_ctx, _agentId, id) => run(`${id}-wrong`, "completed"),
            },
        });
        try {
            await expect(
                waitTest.module.wait(waitTest.database.context, OWNER, "wait-id"),
            ).rejects.toThrow("unrelated wait");
        } finally {
            waitTest.database.close();
        }

        const mutationTest = await harness("workflow-runtime-mutation-validation");
        try {
            await mutationTest.module.launch(mutationTest.database.context, OWNER, {
                workflow: "demo",
                operationId: "mutation-target",
            });
            mutationTest.runtime.cancel = async (_ctx, agentId, request) => ({
                agentId,
                operationId: "wrong-operation",
                run: run(request.id, "cancelled", { updatedAt: 2 }),
                changed: true,
            });
            await expect(
                mutationTest.module.cancel(mutationTest.database.context, OWNER, {
                    id: "mutation-target",
                    operationId: "mutation-operation",
                }),
            ).rejects.toThrow("unrelated mutation");
            await expect(
                mutationTest.module.status(mutationTest.database.context, OWNER, "mutation-target"),
            ).resolves.toMatchObject({ status: "queued" });
        } finally {
            mutationTest.database.close();
        }
    });

    it("rejects a schema-valid launch result whose workflow or input disagrees with the request", async () => {
        const test = await harness("workflow-runtime-semantic-validation", {
            runtime: {
                launch: async (_ctx, agentId, request) =>
                    run(request.operationId, "queued", {
                        agentId,
                        workflow: "different-workflow",
                        input: "different-input",
                    }),
            },
        });
        try {
            await expect(
                test.module.launch(test.database.context, OWNER, {
                    workflow: "requested-workflow",
                    input: "requested-input",
                    operationId: "semantic-mismatch",
                }),
            ).rejects.toThrow("wrong identity or input");
            await expect(
                test.module.status(test.database.context, OWNER, "semantic-mismatch"),
            ).resolves.toBeUndefined();
        } finally {
            test.database.close();
        }
    });

    it("invokes runtime methods through the supplied adapter and rejects changed mismatches", async () => {
        const calls: string[] = [];
        const adapter: WorkflowRuntime = {
            launch: async (_ctx, agentId, request) => {
                calls.push(`launch:${agentId}`);
                return run(request.operationId, "queued", {
                    agentId,
                    workflow: request.workflow,
                });
            },
            cancel: async (_ctx, agentId, request) => {
                calls.push(`cancel:${agentId}`);
                return {
                    agentId,
                    operationId: request.operationId,
                    run: run(request.id, "cancelled", { updatedAt: 2 }),
                    changed: false,
                };
            },
            resume: async (_ctx, agentId, request) => {
                calls.push(`resume:${agentId}`);
                return {
                    agentId,
                    operationId: request.operationId,
                    run: run(request.id, "running"),
                    changed: true,
                };
            },
            wait: async () => run("unused", "unavailable"),
        };
        const test = await harness("workflow-runtime-this", {
            runtime: adapter,
        });
        try {
            await test.module.launch(test.database.context, OWNER, {
                workflow: "demo",
                operationId: "bound-runtime",
            });
            expect(calls).toEqual(["launch:workflow-owner"]);
            test.runtime.cancel = async (_ctx, agentId, request) => ({
                agentId,
                operationId: request.operationId,
                run: run(request.id, "cancelled", { updatedAt: 2 }),
                changed: false,
            });
            await expect(
                test.module.cancel(test.database.context, OWNER, {
                    id: "bound-runtime",
                    operationId: "cancel-operation",
                }),
            ).rejects.toThrow("stored transition");
        } finally {
            test.database.close();
        }
    });

    it("enforces legal cancellation/resume transitions and terminal no-op semantics", async () => {
        const test = await harness("workflow-transitions", {
            runtime: {
                launch: async (_ctx, agentId, request) =>
                    request.operationId === "paused-run"
                        ? run(request.operationId, "paused", {
                              agentId,
                              workflow: request.workflow,
                              updatedAt: 2,
                          })
                        : run(request.operationId, "queued", {
                              agentId,
                              workflow: request.workflow,
                          }),
            },
        });
        try {
            await test.module.launch(test.database.context, OWNER, {
                workflow: "queued",
                operationId: "queued-run",
            });
            test.runtimeRuns.set("queued-run", run("queued-run", "queued", { workflow: "queued" }));
            const queuedCancel = await test.module.cancel(test.database.context, OWNER, {
                id: "queued-run",
                operationId: "queued-cancel",
            });
            expect(queuedCancel).toMatchObject({ changed: true, run: { status: "cancelled" } });
            const terminalCancel = await test.module.cancel(test.database.context, OWNER, {
                id: "queued-run",
                operationId: "terminal-cancel",
            });
            expect(terminalCancel).toMatchObject({ changed: false, run: { status: "cancelled" } });
            await expect(
                test.module.resume(test.database.context, OWNER, {
                    id: "queued-run",
                    operationId: "invalid-resume",
                }),
            ).rejects.toThrow("Only a paused workflow");

            await test.module.launch(test.database.context, OWNER, {
                workflow: "paused",
                operationId: "paused-run",
            });
            test.runtimeRuns.set(
                "paused-run",
                run("paused-run", "paused", { updatedAt: 2, workflow: "paused" }),
            );
            const resumed = await test.module.resume(test.database.context, OWNER, {
                id: "paused-run",
                operationId: "resume-operation",
            });
            expect(resumed).toMatchObject({ changed: true, run: { status: "running" } });
            const runningResume = await test.module.resume(test.database.context, OWNER, {
                id: "paused-run",
                operationId: "running-resume",
            });
            expect(runningResume).toMatchObject({ changed: false, run: { status: "running" } });
        } finally {
            test.database.close();
        }
    });

    it("rejects mutation results that change immutable identity or lifecycle fields", async () => {
        const test = await harness("workflow-mutation-field-validation");
        try {
            await test.module.launch(test.database.context, OWNER, {
                workflow: "demo",
                input: "original",
                operationId: "field-target",
            });
            test.runtime.cancel = async (_ctx, agentId, request) => ({
                agentId,
                operationId: request.operationId,
                run: run(request.id, "cancelled", {
                    agentId,
                    workflow: "changed-workflow",
                    input: "changed-input",
                    updatedAt: 2,
                }),
                changed: true,
            });
            await expect(
                test.module.cancel(test.database.context, OWNER, {
                    id: "field-target",
                    operationId: "field-operation",
                }),
            ).rejects.toThrow("changed fields");
            await expect(
                test.module.status(test.database.context, OWNER, "field-target"),
            ).resolves.toMatchObject({ workflow: "demo", input: "original", status: "queued" });
        } finally {
            test.database.close();
        }
    });

    it("persists terminal waits across a fresh module instance and rejects nonterminal waits", async () => {
        const test = await harness("workflow-restart");
        try {
            await test.module.launch(test.database.context, OWNER, {
                workflow: "demo",
                operationId: "restart-run",
            });
            test.runtimeRuns.set(
                "restart-run",
                run("restart-run", "completed", {
                    updatedAt: 4,
                    startedAt: 1,
                    output: "finished",
                }),
            );
            const completed = await test.module.wait(test.database.context, OWNER, "restart-run");
            expect(completed.status).toBe("completed");

            const restarted = new WorkflowsModule({
                runtime: test.runtime,
                idFactory: () => "restarted-id",
                eventIdFactory: () => "restarted-event",
                clock: () => 20,
            });
            await expect(
                restarted.status(test.database.context, OWNER, "restart-run"),
            ).resolves.toEqual(completed);

            test.runtimeRuns.set("queued-run", run("queued-run", "running", { updatedAt: 2 }));
            await expect(
                test.module.wait(test.database.context, OWNER, "queued-run"),
            ).rejects.toThrow("before a terminal");
        } finally {
            test.database.close();
        }
    });

    it("passes the caller lifetime to the host and never invokes cancellation for a cancelled wait", async () => {
        const controller = new AbortController();
        let receivedSignal: AbortSignal | undefined;
        let cancelCalls = 0;
        let release!: (value: WorkflowRun) => void;
        const test = await harness("workflow-wait-lifetime", {
            runtime: {
                cancel: async () => {
                    cancelCalls += 1;
                    return {
                        agentId: OWNER,
                        operationId: "cancel",
                        run: run("wait-run", "cancelled", { updatedAt: 2 }),
                        changed: true,
                    };
                },
                wait: async (_ctx, agentId, id, signal) => {
                    receivedSignal = signal;
                    return await new Promise<WorkflowRun>((resolve) => {
                        release = resolve;
                    }).then((value) => ({ ...value, agentId, id }));
                },
            },
        });
        try {
            const pending = test.module.wait(
                withLifetime(test.database.context, controller.signal),
                OWNER,
                "wait-run",
            );
            await Promise.resolve();
            expect(receivedSignal).toBe(controller.signal);
            controller.abort();
            await expect(pending).rejects.toThrow("continues running in the background");
            expect(cancelCalls).toBe(0);
            release(run("wait-run", "completed", { updatedAt: 2 }));
        } finally {
            test.database.close();
        }
    });

    it("does not expose another agent's run through status, list, or logs", async () => {
        const test = await harness("workflow-agent-isolation");
        try {
            await insertRun(
                test.database,
                run("secret", "queued", { agentId: OTHER_OWNER }),
                OTHER_OWNER,
                "secret",
            );
            await expect(
                test.module.status(test.database.context, OWNER, "secret"),
            ).resolves.toBeUndefined();
            const page = await test.module.list(test.database.context, OWNER);
            expect(page.runs).toEqual([]);
            await expect(
                test.module.logs(test.database.context, OWNER, { id: "secret" }),
            ).rejects.toThrow("not found");
            await expect(
                test.module.status(test.database.context, OTHER_OWNER, "secret"),
            ).resolves.toMatchObject({ id: "secret", agentId: OTHER_OWNER });
        } finally {
            test.database.close();
        }
    });

    it("rejects malformed persisted JSON and semantic rows on reload", async () => {
        const malformedJson = await harness("workflow-malformed-json");
        try {
            await agentDatabaseRun(
                malformedJson.database.database,
                sql`INSERT INTO ${sql.raw(WORKFLOW_RUNS_TABLE)}
                    (agent_id, id, workflow, status, created_at, updated_at, run_json)
                    VALUES (${OWNER}, ${"json-bad"}, ${"demo"}, ${"queued"}, 1, 1, ${"{"})`,
            );
            await expect(
                malformedJson.module.status(malformedJson.database.context, OWNER, "json-bad"),
            ).rejects.toThrow("invalid JSON");
        } finally {
            malformedJson.database.close();
        }

        const malformedState = await harness("workflow-malformed-state");
        try {
            await insertRun(
                malformedState.database,
                { ...run("state-bad"), updatedAt: 0 },
                OWNER,
                "state-bad",
            );
            await expect(
                malformedState.module.status(malformedState.database.context, OWNER, "state-bad"),
            ).rejects.toThrow("invalid timestamp");
        } finally {
            malformedState.database.close();
        }
    });

    it("pages runs and logs with exact limits and both directions", async () => {
        const test = await harness("workflow-paging", {
            module: { maxPageSize: 2, maxLogLines: 2 },
        });
        try {
            for (const id of ["a-run", "b-run", "c-run"]) {
                await test.module.launch(test.database.context, OWNER, {
                    workflow: "demo",
                    operationId: id,
                });
            }
            const first = await test.module.list(test.database.context, OWNER, { limit: 2 });
            expect(first.runs.map(({ id }) => id)).toEqual(["a-run", "b-run"]);
            expect(first.nextCursor).toBe(2);
            if (first.nextCursor === undefined) throw new Error("Expected a run cursor.");
            const last = await test.module.list(test.database.context, OWNER, {
                limit: 2,
                cursor: first.nextCursor,
            });
            expect(last.runs.map(({ id }) => id)).toEqual(["c-run"]);
            expect(last.previousCursor).toBe(0);
            const end = await test.module.list(test.database.context, OWNER, {
                from: "end",
                limit: 2,
            });
            expect(end.runs.map(({ id }) => id)).toEqual(["b-run", "c-run"]);
            await expect(
                test.module.list(test.database.context, OWNER, { limit: 3 }),
            ).rejects.toThrow("configured bound");

            await insertLog(test.database, "a-run", 0, "zero");
            await insertLog(test.database, "a-run", 1, "one");
            await insertLog(test.database, "a-run", 2, "two");
            const logs = await test.module.logs(test.database.context, OWNER, {
                id: "a-run",
                limit: 2,
            });
            expect(logs.lines.map(({ text }) => text)).toEqual(["zero", "one"]);
            expect(logs.nextCursor).toBe(2);
            if (logs.nextCursor === undefined) throw new Error("Expected a log cursor.");
            const lastLogs = await test.module.logs(test.database.context, OWNER, {
                id: "a-run",
                limit: 2,
                cursor: logs.nextCursor,
            });
            expect(lastLogs.lines.map(({ text }) => text)).toEqual(["two"]);
            expect(lastLogs.previousCursor).toBe(0);
        } finally {
            test.database.close();
        }
    });

    it("returns an empty run page with a usable previous cursor beyond the end", async () => {
        const test = await harness("workflow-page-beyond-end");
        try {
            await test.module.launch(test.database.context, OWNER, {
                workflow: "demo",
                operationId: "only-run",
            });
            await expect(
                test.module.list(test.database.context, OWNER, { cursor: 99, limit: 1 }),
            ).resolves.toMatchObject({ runs: [] });
        } finally {
            test.database.close();
        }
    });

    it("returns an empty log page with a usable previous cursor beyond the end", async () => {
        const test = await harness("workflow-log-page-beyond-end");
        try {
            await test.module.launch(test.database.context, OWNER, {
                workflow: "demo",
                operationId: "logged-run",
            });
            await insertLog(test.database, "logged-run", 0, "line");
            await expect(
                test.module.logs(test.database.context, OWNER, {
                    id: "logged-run",
                    cursor: 99,
                    limit: 1,
                }),
            ).resolves.toMatchObject({ lines: [] });
        } finally {
            test.database.close();
        }
    });

    it("filters terminal runs at the storage boundary and pages logs from the end", async () => {
        const test = await harness("workflow-terminal-filter");
        try {
            await test.module.launch(test.database.context, OWNER, {
                workflow: "active",
                operationId: "active-run",
            });
            await test.module.launch(test.database.context, OWNER, {
                workflow: "terminal",
                operationId: "terminal-run",
            });
            test.runtimeRuns.set(
                "terminal-run",
                run("terminal-run", "completed", {
                    workflow: "terminal",
                    updatedAt: 2,
                }),
            );
            await test.module.wait(test.database.context, OWNER, "terminal-run");
            const active = await test.module.list(test.database.context, OWNER, {
                includeTerminal: false,
            });
            expect(active.runs.map(({ id }) => id)).toEqual(["active-run"]);
            await insertLog(test.database, "active-run", 0, "first");
            await insertLog(test.database, "active-run", 1, "last");
            await expect(
                test.module.logs(test.database.context, OWNER, {
                    id: "active-run",
                    from: "end",
                    limit: 1,
                }),
            ).resolves.toMatchObject({
                lines: [{ position: 1, text: "last" }],
                previousCursor: 0,
            });
        } finally {
            test.database.close();
        }
    });

    it("keeps model output bounded and identifies truncation", async () => {
        const test = await harness("workflow-output-bounds", {
            module: { maxOutputCharacters: 256 },
        });
        try {
            const max = `x${"y".repeat(MAX_WORKFLOW_ID_LENGTH - 1)}`;
            const page = {
                agentId: OWNER,
                cursor: 0,
                runs: [run(max, "completed", { workflow: max, updatedAt: 2 })],
                totalRuns: 1,
            };
            const pageText = test.module.formatPageForModel(page);
            expect(pageText.length).toBeLessThanOrEqual(256);
            expect(pageText).toContain(max);
            const statusText = test.module.formatRunForModel(
                run("failed-run", "failed", {
                    updatedAt: 2,
                    error: "error-".repeat(600),
                    output: "output-".repeat(1_000),
                    logs: ["log-".repeat(1_000)],
                }),
            );
            expect(statusText.length).toBeLessThanOrEqual(256);
            expect(statusText).toContain("logs_truncated");
            const logPage = {
                agentId: OWNER,
                id: "failed-run",
                cursor: 0,
                lines: [{ position: 0, text: "line-".repeat(MAX_WORKFLOW_LOG_LINE_LENGTH / 5) }],
                totalLines: 1,
            };
            const logsText = test.module.formatLogsForModel(logPage);
            expect(logsText.length).toBeLessThanOrEqual(256);
            expect(logsText).toContain("…");
        } finally {
            test.database.close();
        }
    });

    it("marks truncated workflow log output explicitly for the model", async () => {
        const test = await harness("workflow-log-output-marker", {
            module: { maxOutputCharacters: 256 },
        });
        try {
            const text = test.module.formatLogsForModel({
                agentId: OWNER,
                id: "run",
                cursor: 0,
                lines: [{ position: 0, text: "x".repeat(MAX_WORKFLOW_LOG_LINE_LENGTH) }],
                totalLines: 1,
            });
            expect(text).toContain("logs_truncated");
        } finally {
            test.database.close();
        }
    });

    it("preserves actionable error detail at the minimum status output budget", async () => {
        const test = await harness("workflow-error-output", {
            module: { maxOutputCharacters: 256 },
        });
        try {
            const text = test.module.formatRunForModel(
                run("failed", "failed", {
                    updatedAt: 2,
                    error: "specific failure reason",
                }),
            );
            expect(text).toContain("specific failure reason");
        } finally {
            test.database.close();
        }
    });

    it("delivers one frozen event to transactional and post-commit listeners", async () => {
        const transactional: WorkflowEvent[] = [];
        const postCommit: WorkflowEvent[] = [];
        const test = await harness("workflow-events", {
            module: {
                listener: {
                    onEventTransactional: (_ctx, event) => {
                        transactional.push(event);
                        expect(Object.isFrozen(event)).toBe(true);
                        expect(Object.isFrozen(event.run)).toBe(true);
                        expect(Object.isFrozen(event.run.logs)).toBe(true);
                    },
                    onEvent: (_ctx, event) => {
                        postCommit.push(event);
                    },
                },
            },
        });
        try {
            await test.module.launch(test.database.context, OWNER, {
                workflow: "demo",
                operationId: "event-run",
            });
            expect(transactional).toHaveLength(1);
            expect(postCommit).toHaveLength(1);
            expect(postCommit[0]).toBe(transactional[0]);
            expect(postCommit[0]).toMatchObject({
                type: "workflow_started",
                agentId: OWNER,
                eventId: "generated-event",
                run: { id: "event-run" },
            });
        } finally {
            test.database.close();
        }
    });

    it("contains post-commit listener failures and reports hostile thrown values", async () => {
        const reports: string[] = [];
        const hostile = Object.create(null, {
            message: {
                get() {
                    throw new Error("message getter failed");
                },
            },
        });
        const test = await harness("workflow-post-commit-failure", {
            module: {
                listener: {
                    onEvent: () => {
                        throw hostile;
                    },
                },
                onPostCommitError: (_ctx, _event, message) => {
                    reports.push(message);
                },
            },
        });
        try {
            await expect(
                test.module.launch(test.database.context, OWNER, {
                    workflow: "demo",
                    operationId: "post-commit-run",
                }),
            ).resolves.toMatchObject({ id: "post-commit-run" });
            expect(reports).toEqual(["Unknown Workflow observer error."]);
        } finally {
            test.database.close();
        }
    });

    it("rolls back a launch when a transactional listener returns a malformed result", async () => {
        const postCommit: WorkflowEvent[] = [];
        const test = await harness("workflow-invalid-transactional-listener", {
            module: {
                listener: {
                    onEventTransactional: () => 1 as never,
                    onEvent: (_ctx, event) => {
                        postCommit.push(event);
                    },
                },
            },
        });
        try {
            await expect(
                test.module.launch(test.database.context, OWNER, {
                    workflow: "demo",
                    operationId: "listener-rejected",
                }),
            ).rejects.toThrow("must return undefined");
            await expect(
                test.module.status(test.database.context, OWNER, "listener-rejected"),
            ).resolves.toBeUndefined();
            expect(postCommit).toEqual([]);
        } finally {
            test.database.close();
        }
    });

    it("rejects invalid event IDs and clocks before exposing an event", async () => {
        const invalidEvent = await harness("workflow-invalid-event-factory", {
            module: {
                eventIdFactory: () => "",
            },
        });
        try {
            await expect(
                invalidEvent.module.launch(invalidEvent.database.context, OWNER, {
                    workflow: "demo",
                    operationId: "invalid-event",
                }),
            ).rejects.toThrow("invalid ID");
            await expect(
                invalidEvent.module.status(invalidEvent.database.context, OWNER, "invalid-event"),
            ).resolves.toBeUndefined();
        } finally {
            invalidEvent.database.close();
        }

        const runtime: WorkflowRuntime = {
            launch: async () => run("clock"),
            cancel: async () => ({
                agentId: OWNER,
                operationId: "op",
                run: run("clock"),
                changed: false,
            }),
            resume: async () => ({
                agentId: OWNER,
                operationId: "op",
                run: run("clock"),
                changed: false,
            }),
            wait: async () => run("clock", "completed"),
        };
        expect(() => new WorkflowsModule({ runtime, clock: () => -1 })).toThrow(
            "non-negative integer",
        );
    });

    it("rolls back durable state and suppresses post-commit events when the outer transaction rolls back", async () => {
        const transactional: WorkflowEvent[] = [];
        const postCommit: WorkflowEvent[] = [];
        const test = await harness("workflow-outer-rollback", {
            module: {
                listener: {
                    onEventTransactional: (_ctx, event) => {
                        transactional.push(event);
                    },
                    onEvent: (_ctx, event) => {
                        postCommit.push(event);
                    },
                },
            },
        });
        try {
            await expect(
                test.database.context.inTx(async (txCtx) => {
                    await test.module.launch(txCtx, OWNER, {
                        workflow: "demo",
                        operationId: "rolled-back",
                    });
                    throw new Error("force outer rollback");
                }),
            ).rejects.toThrow("force outer rollback");
            expect(transactional).toHaveLength(1);
            expect(postCommit).toHaveLength(0);
            await expect(
                test.module.status(test.database.context, OWNER, "rolled-back"),
            ).resolves.toBeUndefined();
        } finally {
            test.database.close();
        }
    });

    it("compensates an external launch when durable persistence or a transactional listener fails", async () => {
        const externalRuns = new Map<string, WorkflowRun>();
        let compensationCalls = 0;
        const test = await harness("workflow-launch-compensation", {
            runtime: {
                launch: async (_ctx, agentId, request) => {
                    const created = run(request.operationId, "queued", {
                        agentId,
                        workflow: request.workflow,
                    });
                    externalRuns.set(created.id, created);
                    return created;
                },
                cancel: async (_ctx, agentId, request) => {
                    compensationCalls += 1;
                    const current = externalRuns.get(request.id);
                    const cancelled = run(request.id, "cancelled", {
                        agentId,
                        workflow: current?.workflow ?? "demo",
                        updatedAt: (current?.updatedAt ?? 1) + 1,
                    });
                    externalRuns.set(request.id, cancelled);
                    return {
                        agentId,
                        operationId: request.operationId,
                        run: cancelled,
                        changed: true,
                    };
                },
            },
            module: {
                listener: {
                    onEventTransactional: () => {
                        throw new Error("transactional observer rejected the launch");
                    },
                },
            },
        });
        try {
            await expect(
                test.module.launch(test.database.context, OWNER, {
                    workflow: "demo",
                    operationId: "orphaned-external-run",
                }),
            ).rejects.toThrow("transactional observer");
            await expect(
                test.module.status(test.database.context, OWNER, "orphaned-external-run"),
            ).resolves.toBeUndefined();
            expect(compensationCalls).toBe(1);
            expect(externalRuns.get("orphaned-external-run")?.status).toBe("cancelled");
        } finally {
            test.database.close();
        }
    });

    it("does not retain a database transaction while invoking an external launch", async () => {
        let rootDatabase: unknown;
        let runtimeDatabase: unknown;
        const test = await harness("workflow-launch-outside-transaction", {
            runtime: {
                launch: async (ctx, agentId, request) => {
                    runtimeDatabase = ctx.db;
                    return run(request.operationId, "queued", {
                        agentId,
                        workflow: request.workflow,
                    });
                },
            },
        });
        try {
            rootDatabase = test.database.database;
            await test.database.context.inTx(async (txCtx) => {
                await test.module.launch(txCtx, OWNER, {
                    workflow: "demo",
                    operationId: "nested-launch",
                });
            });
            expect(runtimeDatabase).toBe(rootDatabase);
        } finally {
            test.database.close();
        }
    });

    it("rejects malformed logs and impossible log positions from storage", async () => {
        const malformed = await harness("workflow-malformed-logs");
        try {
            await malformed.module.launch(malformed.database.context, OWNER, {
                workflow: "demo",
                operationId: "log-run",
            });
            await insertLog(malformed.database, "log-run", 0, "valid");
            await agentDatabaseRun(
                malformed.database.database,
                sql`UPDATE ${sql.raw(WORKFLOW_LOGS_TABLE)}
                    SET text = ${"x".repeat(MAX_WORKFLOW_LOG_LINE_LENGTH + 1)}
                    WHERE agent_id = ${OWNER} AND run_id = ${"log-run"} AND position = 0`,
            );
            await expect(
                malformed.module.logs(malformed.database.context, OWNER, { id: "log-run" }),
            ).rejects.toThrow("invalid log page");
        } finally {
            malformed.database.close();
        }

        const missingRun = await harness("workflow-missing-log-run");
        try {
            await insertLog(missingRun.database, "missing", 0, "orphan");
            await expect(
                missingRun.module.logs(missingRun.database.context, OWNER, { id: "missing" }),
            ).rejects.toThrow("not found");
        } finally {
            missingRun.database.close();
        }
    });

    it("does not allow a concurrent duplicate launch to create two host runs", async () => {
        let enteredResolve!: () => void;
        const entered = new Promise<void>((resolve) => {
            enteredResolve = resolve;
        });
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        let launchCalls = 0;
        const test = await harness("workflow-concurrent-launch", {
            runtime: {
                launch: async (ctx, agentId, request) => {
                    launchCalls += 1;
                    if (launchCalls === 1) {
                        enteredResolve();
                        await gate;
                    }
                    return run(request.operationId, "queued", {
                        agentId,
                        workflow: request.workflow,
                    });
                },
            },
        });
        try {
            const first = test.module.launch(test.database.context, OWNER, {
                workflow: "demo",
                operationId: "same-launch",
            });
            await entered;
            const second = test.module.launch(test.database.context, OWNER, {
                workflow: "demo",
                operationId: "same-launch",
            });
            await new Promise<void>((resolve) => setImmediate(resolve));
            expect(launchCalls).toBe(2);
            release();
            const results = await Promise.allSettled([first, second]);
            expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
            expect(launchCalls).toBe(1);
        } finally {
            release();
            test.database.close();
        }
    });
});
