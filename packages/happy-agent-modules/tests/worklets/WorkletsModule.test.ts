import { randomUUID } from "node:crypto";
import {
    lstat,
    mkdir,
    mkdtemp,
    readFile,
    readdir,
    rm,
    symlink,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { Value } from "@sinclair/typebox/value";
import type { AgentModuleScope } from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";
import { afterEach, describe, expect, it } from "vitest";

import {
    WORKLET_PROOFS_TABLE,
    WORKLET_RECEIPTS_TABLE,
    WORKLET_TABLE,
    createWorkletDatabase,
} from "../../sources/worklets/WorkletDatabase.js";
import {
    WORKLET_SOURCE_MAX_DEPTH,
    WORKLET_SOURCE_MAX_FILE_BYTES,
    WorkletsModule,
    assertWorkletModuleOptions,
    workletInvocationResultSchema,
    workletRuntimeSchema,
    type WorkletEvent,
    type WorkletInvocationResult,
    type WorkletLogPage,
    type WorkletRuntime,
    type WorkletRuntimeInvocationRequest,
    type WorkletRuntimeLogQuery,
    type WorkletStatus,
} from "../../sources/worklets/index.js";
import { moduleDatabase, type ModuleDatabase } from "../support/moduleDatabase.js";

type Operation = { readonly name: string; readonly description?: string };

const tempPaths: string[] = [];
const databases: ModuleDatabase[] = [];

afterEach(async () => {
    for (const database of databases.splice(0)) database.close();
    await Promise.all(
        tempPaths
            .splice(0)
            .map((path) => rm(path, { force: true, recursive: true }).catch(() => undefined)),
    );
});

async function tempDir(prefix: string): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), prefix));
    tempPaths.push(directory);
    return directory;
}

async function exists(path: string): Promise<boolean> {
    try {
        await lstat(path);
        return true;
    } catch {
        return false;
    }
}

async function makeSource(
    operations: readonly Operation[],
    extra?: (directory: string) => Promise<void>,
): Promise<string> {
    const directory = await tempDir("worklet-source-");
    await writeFile(join(directory, "index.ts"), "export const run = (): void => {};\n");
    await writeFile(
        join(directory, "worklet.json"),
        JSON.stringify({ name: "declared", operations }),
    );
    await writeFile(
        join(directory, "favicon.png"),
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]),
    );
    await extra?.(directory);
    return directory;
}

class MemoryRuntime {
    readonly statuses = new Map<string, WorkletStatus>();
    readonly logs = new Map<string, string[]>();
    readonly invocations: WorkletRuntimeInvocationRequest[] = [];
    readonly contract: WorkletRuntime;

    constructor() {
        this.contract = {
            status: this.status.bind(this),
            readLogs: this.readLogs.bind(this),
            invokeOperation: this.invokeOperation.bind(this),
        };
        if (!Value.Check(workletRuntimeSchema, this.contract)) {
            throw new Error("The test runtime does not satisfy WorkletRuntime.");
        }
    }

    async status(_ctx: Context, name: string): Promise<WorkletStatus> {
        return structuredClone(
            this.statuses.get(name) ?? { name, state: "asleep", at: 1 },
        );
    }

    async readLogs(
        _ctx: Context,
        query: WorkletRuntimeLogQuery,
    ): Promise<WorkletLogPage> {
        const all = this.logs.get(query.name) ?? [];
        const cursor =
            query.from === "end"
                ? Math.max(0, all.length - query.limit)
                : (query.cursor ?? 0);
        const lines = all
            .slice(cursor, cursor + query.limit)
            .map((text, index) => ({
                position: cursor + index,
                text: text.slice(0, query.maxLineCharacters),
            }));
        const nextCursor =
            cursor + lines.length < all.length
                ? cursor + lines.length
                : undefined;
        return {
            name: query.name,
            cursor,
            lines,
            totalLines: all.length,
            ...(cursor > 0
                ? { previousCursor: Math.max(0, cursor - query.limit) }
                : {}),
            ...(nextCursor === undefined ? {} : { nextCursor }),
        };
    }

    async invokeOperation(
        _ctx: Context,
        request: WorkletRuntimeInvocationRequest,
    ): Promise<WorkletInvocationResult> {
        this.invocations.push(structuredClone(request));
        const result = {
            name: request.name,
            operation: request.operation,
            result: structuredClone(request.arguments),
        };
        if (!Value.Check(workletInvocationResultSchema, result)) {
            throw new Error("The test invocation result is invalid.");
        }
        return result;
    }
}

type Harness = {
    readonly ctx: Context;
    readonly database: ModuleDatabase;
    readonly installRoot: string;
    readonly module: WorkletsModule;
    readonly runtime: MemoryRuntime;
    readonly pingSource: string;
    readonly echoSource: string;
};

async function setup(
    overrides: Partial<ConstructorParameters<typeof WorkletsModule>[0]> = {},
): Promise<Harness> {
    const runtime = new MemoryRuntime();
    const installRoot = join(await tempDir("worklet-install-"), "worklets");
    const module = new WorkletsModule({
        runtime: runtime.contract,
        installRoot,
        idFactory: (_ctx, agentId) => `operation-${agentId}-${randomUUID()}`,
        eventIdFactory: (_ctx, agentId) => `event-${agentId}-${randomUUID()}`,
        clock: () => 500,
        ...overrides,
    });
    const database = moduleDatabase([], `worklets-${randomUUID()}`);
    databases.push(database);
    await database.ready;
    for (const [, migrate] of module.migrations) {
        await migrate(database.context, database.database);
    }
    return {
        ctx: database.context,
        database,
        installRoot,
        module,
        runtime,
        pingSource: await makeSource([
            { name: "ping", description: "Return a ping." },
        ]),
        echoSource: await makeSource([
            { name: "echo", description: "Echo arguments." },
        ]),
    };
}

function scopeFor(agentId: string): AgentModuleScope {
    return { agent: { id: agentId } } as AgentModuleScope;
}

function toolCall(id: string) {
    return {
        id,
        commit: () => {
            throw new Error("Worklet tools must let Agent Base commit the returned result.");
        },
    } as never;
}

describe("WorkletsModule", () => {
    it("keeps only the catalog table after the immutable drop migration", async () => {
        const { database } = await setup();
        const tables = database.database.all<{ name: string }>(
            "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
        );
        await expect(tables).resolves.toEqual([{ name: WORKLET_TABLE }]);
        expect(WORKLET_RECEIPTS_TABLE).toContain("receipts");
        expect(WORKLET_PROOFS_TABLE).toContain("proofs");
    });

    it("installs, updates, and reverts while preserving versions and Data", async () => {
        const { ctx, echoSource, installRoot, module, pingSource } = await setup();
        const installed = await module.install(ctx, "agent-a", {
            name: "weather-worker",
            sourceRef: pingSource,
            operationId: "install-operation",
        });
        const base = join(installRoot, "weather-worker");
        await writeFile(join(base, "Data", "state.json"), '{"kept":true}');

        const updated = await module.update(ctx, "agent-a", installed.name, {
            sourceRef: echoSource,
            changeDescription: "Add echo",
            operationId: "update-operation",
        });
        const reverted = await module.revert(ctx, "agent-a", installed.name, {
            version: 1,
            operationId: "revert-operation",
        });

        expect(updated.currentVersion).toBe(2);
        expect(updated.versions.map((version) => version.operationId)).toEqual([
            "install-operation",
            "update-operation",
        ]);
        expect(reverted.currentVersion).toBe(1);
        expect(reverted.operations.map((operation) => operation.name)).toEqual([
            "ping",
        ]);
        expect(await exists(join(base, "v1"))).toBe(true);
        expect(await exists(join(base, "v2"))).toBe(true);
        expect(await readFile(join(base, "Data", "state.json"), "utf8")).toBe(
            '{"kept":true}',
        );
    });

    it("uses call.id while Agent Base owns transactional durable completion", async () => {
        const { ctx, echoSource, module, pingSource } = await setup();
        const [installTool, , , updateTool, revertTool] = module.tools(
            ctx,
            scopeFor("agent-a"),
        );

        const installed = await installTool!.execute(
            ctx,
            { name: "tool-worker", sourceRef: pingSource },
            toolCall("call-install"),
        );
        const updated = await updateTool!.execute(
            ctx,
            {
                name: "tool-worker",
                sourceRef: echoSource,
                changeDescription: "Add echo",
            },
            toolCall("call-update"),
        );
        const reverted = await revertTool!.execute(
            ctx,
            { name: "tool-worker", version: 1 },
            toolCall("call-revert"),
        );

        expect(installed.worklet.versions[0]?.operationId).toBe("call-install");
        expect(updated.worklet.versions[1]?.operationId).toBe("call-update");
        expect(reverted.worklet.currentVersion).toBe(1);
        expect(installTool!.transactional).toBe(true);
        expect(updateTool!.transactional).toBe(true);
        expect(revertTool!.transactional).toBe(true);
    });

    it("uses installer reconciliation after an outer transaction rolls back", async () => {
        const { ctx, installRoot, module, pingSource } = await setup();
        const [installTool] = module.tools(ctx, scopeFor("agent-a"));
        await expect(
            ctx.inTx(async (txCtx) => {
                await installTool!.execute(
                    txCtx,
                    { name: "rollback-worker", sourceRef: pingSource },
                    toolCall("call-rolls-back"),
                );
                throw new Error("outer transaction failed");
            }),
        ).rejects.toThrow("outer transaction failed");

        expect(
            await createWorkletDatabase().get(ctx, "rollback-worker"),
        ).toBeUndefined();
        await expect(
            module.install(ctx, "agent-a", {
                name: "rollback-worker",
                sourceRef: pingSource,
                operationId: "retry-after-rollback",
            }),
        ).resolves.toMatchObject({
            name: "rollback-worker",
            versions: [{ operationId: "retry-after-rollback" }],
        });
        expect(await exists(join(installRoot, "rollback-worker", "v1"))).toBe(true);
    });

    it("does not implement module-owned replay for repeated operation IDs", async () => {
        const { ctx, module, pingSource } = await setup();
        await module.install(ctx, "agent-a", {
            name: "plain-worker",
            sourceRef: pingSource,
            operationId: "same-operation",
        });
        await expect(
            module.install(ctx, "agent-a", {
                name: "plain-worker",
                sourceRef: pingSource,
                operationId: "same-operation",
            }),
        ).rejects.toThrow("already exists");
    });

    it("marks external removal and invocation boundaries non-durable", async () => {
        const { ctx, module } = await setup();
        const tools = module.tools(ctx, scopeFor("agent-a"));
        expect(tools.find((tool) => tool.name === "install_worklet")?.durable).toBe(
            true,
        );
        expect(
            tools.find((tool) => tool.name === "install_worklet")?.transactional,
        ).toBe(true);
        expect(tools.find((tool) => tool.name === "update_worklet")?.durable).toBe(
            true,
        );
        expect(
            tools.find((tool) => tool.name === "update_worklet")?.transactional,
        ).toBe(true);
        expect(tools.find((tool) => tool.name === "revert_worklet")?.durable).toBe(
            true,
        );
        expect(
            tools.find((tool) => tool.name === "revert_worklet")?.transactional,
        ).toBe(true);
        expect(tools.find((tool) => tool.name === "remove_worklet")?.durable).toBe(
            false,
        );
        expect(
            tools.find((tool) => tool.name === "invoke_worklet_operation")?.durable,
        ).toBe(false);
    });

    it("keeps Data when removal deletes code and the icon", async () => {
        const { ctx, installRoot, module, pingSource } = await setup();
        await module.install(ctx, "agent-a", {
            name: "removed-worker",
            sourceRef: pingSource,
            operationId: "install-removed",
        });
        const base = join(installRoot, "removed-worker");
        await writeFile(join(base, "Data", "keep.txt"), "keep");

        await expect(
            module.remove(ctx, "agent-a", "removed-worker", "remove-operation"),
        ).resolves.toBe(true);
        expect(await exists(join(base, "v1"))).toBe(false);
        expect(await exists(join(base, "favicon.png"))).toBe(false);
        expect(await readFile(join(base, "Data", "keep.txt"), "utf8")).toBe(
            "keep",
        );
    });

    it("rolls catalog and filesystem back when a transactional listener rejects", async () => {
        const { ctx, installRoot, module, pingSource } = await setup({
            listener: {
                onEventTransactional: () => {
                    throw new Error("listener rejected");
                },
            },
        });
        await expect(
            module.install(ctx, "agent-a", {
                name: "listener-worker",
                sourceRef: pingSource,
                operationId: "listener-install",
            }),
        ).rejects.toThrow("listener rejected");
        expect(
            await createWorkletDatabase().get(ctx, "listener-worker"),
        ).toBeUndefined();
        expect(await exists(join(installRoot, "listener-worker"))).toBe(false);
    });

    it("publishes one frozen event after each changed commit", async () => {
        const transactional: WorkletEvent[] = [];
        const committed: WorkletEvent[] = [];
        const { ctx, module, pingSource } = await setup({
            listener: {
                onEventTransactional: (_ctx, event) => {
                    transactional.push(event);
                },
                onEvent: (_ctx, event) => {
                    committed.push(event);
                },
            },
        });
        await module.install(ctx, "agent-a", {
            name: "event-worker",
            sourceRef: pingSource,
            operationId: "event-install",
        });
        await module.revert(ctx, "agent-a", "event-worker", {
            version: 1,
            operationId: "event-noop",
        });

        expect(transactional).toHaveLength(1);
        expect(committed).toHaveLength(1);
        expect(committed[0]).toBe(transactional[0]);
        expect(Object.isFrozen(committed[0])).toBe(true);
    });

    it("rejects source symlinks without creating an installed worklet", async () => {
        const { ctx, installRoot, module } = await setup();
        const outside = await tempDir("worklet-outside-");
        await writeFile(join(outside, "secret.txt"), "secret");
        const source = await makeSource([{ name: "ping" }], async (directory) => {
            await symlink(join(outside, "secret.txt"), join(directory, "escape"));
        });

        await expect(
            module.install(ctx, "agent-a", {
                name: "symlink-worker",
                sourceRef: source,
                operationId: "symlink-install",
            }),
        ).rejects.toThrow("symbolic link");
        expect(await exists(join(installRoot, "symlink-worker"))).toBe(false);
    });

    it("rejects a source that contains the install root", async () => {
        const { ctx, installRoot, module } = await setup();
        await expect(
            module.install(ctx, "agent-a", {
                name: "ancestor-worker",
                sourceRef: dirname(installRoot),
                operationId: "ancestor-install",
            }),
        ).rejects.toThrow("contain one another");
        expect(await exists(join(installRoot, "ancestor-worker"))).toBe(false);
    });

    it("reconciles crash leftovers without touching durable Data", async () => {
        const { ctx, installRoot, module, pingSource } = await setup();
        const base = join(installRoot, "crash-worker");
        await mkdir(join(base, "Data"), { recursive: true });
        await writeFile(join(base, "Data", "state.txt"), "durable");
        await mkdir(join(base, ".v1-deadbeef"), { recursive: true });
        await writeFile(join(base, ".v1-deadbeef", "partial.ts"), "partial");
        await writeFile(join(base, ".favicon-deadbeef.png"), "partial");

        await module.install(ctx, "agent-a", {
            name: "crash-worker",
            sourceRef: pingSource,
            operationId: "crash-install",
        });

        const entries = await readdir(base);
        expect(entries.some((entry) => entry.startsWith(".v"))).toBe(false);
        expect(entries.some((entry) => entry.startsWith(".favicon-"))).toBe(false);
        expect(await readFile(join(base, "Data", "state.txt"), "utf8")).toBe(
            "durable",
        );
        expect(await exists(join(base, "v1"))).toBe(true);
    });

    it("bounds deep and oversized source trees", async () => {
        const { ctx, installRoot, module } = await setup();
        const deepSource = await makeSource([{ name: "ping" }], async (directory) => {
            let current = directory;
            for (let index = 0; index < WORKLET_SOURCE_MAX_DEPTH + 2; index += 1) {
                current = join(current, `nested-${String(index)}`);
                await mkdir(current);
            }
            await writeFile(join(current, "deep.ts"), "deep");
        });
        await expect(
            module.install(ctx, "agent-a", {
                name: "deep-worker",
                sourceRef: deepSource,
                operationId: "deep-install",
            }),
        ).rejects.toThrow("depth");

        const largeSource = await makeSource(
            [{ name: "ping" }],
            async (directory) => {
                await writeFile(
                    join(directory, "large.bin"),
                    Buffer.alloc(WORKLET_SOURCE_MAX_FILE_BYTES + 1),
                );
            },
        );
        await expect(
            module.install(ctx, "agent-a", {
                name: "large-worker",
                sourceRef: largeSource,
                operationId: "large-install",
            }),
        ).rejects.toThrow("10 MiB");
        expect(await exists(join(installRoot, "large-worker"))).toBe(false);
    });

    it("bounds runtime logs and invokes only declared operations", async () => {
        const { ctx, echoSource, module, runtime } = await setup();
        await module.install(ctx, "agent-a", {
            name: "runtime-worker",
            sourceRef: echoSource,
            operationId: "runtime-install",
        });
        runtime.logs.set("runtime-worker", ["first", "second"]);
        const logs = await module.readLogs(ctx, "agent-a", "runtime-worker", {
            limit: 1,
        });
        expect(logs.lines.map((line) => line.text)).toEqual(["first"]);
        expect(logs.nextCursor).toBe(1);

        await expect(
            module.invokeOperation(ctx, "agent-a", {
                name: "runtime-worker",
                operation: "echo",
                arguments: { message: "hello" },
            }),
        ).resolves.toMatchObject({ result: { message: "hello" } });
        await expect(
            module.invokeOperation(ctx, "agent-a", {
                name: "runtime-worker",
                operation: "missing",
            }),
        ).rejects.toThrow("does not declare");
        expect(runtime.invocations).toHaveLength(1);
    });

    it("validates module options before dereferencing the runtime", () => {
        expect(() => assertWorkletModuleOptions({})).toThrow(
            "Worklet module options are invalid",
        );
        expect(() => new WorkletsModule({} as never)).toThrow(
            "Worklet module options are invalid",
        );
    });
});