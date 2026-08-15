import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import {
    link,
    lstat,
    mkdir,
    mkdtemp,
    readdir,
    readFile,
    rm,
    symlink,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { AgentKV, withAgentKV, type AgentFeatureScope } from "@slopus/happy-agent-base";
import { Value } from "@sinclair/typebox/value";
import { createRootContext, type Context } from "@steve.kite/stdlib";
import { afterEach, describe, expect, it } from "vitest";

import {
    MAX_WORKLET_DETAIL_PAGE_SIZE,
    MAX_WORKLET_CHANGE_DESCRIPTION_LENGTH,
    MAX_WORKLET_OPERATION_DESCRIPTION_LENGTH,
    MAX_WORKLET_OPERATIONS,
    MAX_WORKLET_RECORD_BYTES,
    MAX_WORKLET_VERSIONS,
    WORKLET_SOURCE_MAX_DEPTH,
    WORKLET_SOURCE_MAX_FILES,
    WORKLET_SOURCE_MAX_FILE_BYTES,
    type Worklet,
    type WorkletCatalog,
    type WorkletCatalogMutationProof,
    type WorkletCatalogMutationReceipt,
    type WorkletCatalogMutationResult,
    type WorkletEvent,
    type WorkletListPage,
    type WorkletLogPage,
    type WorkletListQuery,
    type WorkletRuntime,
    type WorkletRuntimeInvocationRequest,
    type WorkletRuntimeLogQuery,
    type WorkletStatus,
    type WorkletInvocationResult,
    workletStateIdentity,
} from "../../sources/worklets/index.js";
import {
    WorkletsFeature as Feature,
    workletCatalogSchema,
    workletInvocationResultSchema,
    workletRuntimeSchema,
} from "../../sources/worklets/index.js";
import type {
    WorkletCatalogInstallInput,
    WorkletCatalogRevertInput,
    WorkletCatalogUpdateInput,
} from "../../sources/worklets/index.js";
import { InMemoryPersistence } from "../support/InMemoryPersistence.js";

const root = createRootContext().named("worklets-feature-test");

const tempPaths: string[] = [];

afterEach(async () => {
    await Promise.all(
        tempPaths
            .splice(0)
            .map((path) => rm(path, { force: true, recursive: true }).catch(() => undefined)),
    );
});

async function tempDir(prefix: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), prefix));
    tempPaths.push(dir);
    return dir;
}

type Operation = { name: string; description?: string };

/**
 * Writes a real worklet source folder: a code file, a `worklet.json` manifest
 * declaring its operations, and (unless suppressed) a favicon the installer
 * copies into the worklet root.
 */
async function makeSource(
    operations: readonly Operation[],
    options: { withIcon?: boolean; extra?: (dir: string) => Promise<void> } = {},
): Promise<string> {
    const dir = await tempDir("worklet-src-");
    await writeFile(join(dir, "index.ts"), "export const run = (): void => {};\n");
    await writeFile(join(dir, "worklet.json"), JSON.stringify({ name: "declared", operations }));
    if (options.withIcon !== false) {
        await writeFile(join(dir, "favicon.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]));
    }
    if (options.extra !== undefined) await options.extra(dir);
    return dir;
}

async function exists(path: string): Promise<boolean> {
    try {
        await lstat(path);
        return true;
    } catch {
        return false;
    }
}

function clone<T>(value: T): T {
    return structuredClone(value);
}

function operationsFor(sourceRef: string): Worklet["operations"] {
    return sourceRef.includes("echo")
        ? [{ name: "echo", description: "Echo arguments." }]
        : [{ name: "ping", description: "Return a ping." }];
}

function makeWorklet(
    name: string,
    ownerAgentId: string,
    sourceRef: string,
    operationId: string,
    version = 1,
    currentVersion = version,
): Worklet {
    const versions = Array.from({ length: version }, (_, index) => {
        const versionNumber = index + 1;
        const ref = versionNumber === version ? sourceRef : `source-${versionNumber}`;
        return {
            version: versionNumber,
            sourceRef: ref,
            changeDescription: versionNumber === 1 ? "Initial install" : `Update ${versionNumber}`,
            operations: operationsFor(ref),
            createdAt: 100 + index,
            operationId: versionNumber === version ? operationId : `op-${name}-${versionNumber}`,
        };
    });
    const current = versions[currentVersion - 1]!;
    return {
        name,
        ownerAgentId,
        currentVersion,
        operations: clone(current.operations),
        versions,
        createdAt: 100,
        updatedAt: current.createdAt,
    };
}

function maximumOperations(): Worklet["operations"] {
    return Array.from({ length: MAX_WORKLET_OPERATIONS }, (_, index) => ({
        name: `operation-${index}`,
        description: "d".repeat(MAX_WORKLET_OPERATION_DESCRIPTION_LENGTH),
    }));
}

function makeMaximumWorklet(name: string): Worklet {
    const operations = maximumOperations();
    const sourceRef = "s".repeat(4_096);
    const versions = Array.from({ length: MAX_WORKLET_VERSIONS }, (_, index) => ({
        version: index + 1,
        sourceRef,
        changeDescription:
            index === 0
                ? "Initial install"
                : "c".repeat(MAX_WORKLET_CHANGE_DESCRIPTION_LENGTH),
        operations: clone(operations),
        createdAt: index,
        operationId: `maximum-operation-${index + 1}`,
    }));
    return {
        name,
        ownerAgentId: "maximum-owner",
        currentVersion: MAX_WORKLET_VERSIONS,
        operations: clone(operations),
        versions,
        createdAt: 0,
        updatedAt: MAX_WORKLET_VERSIONS - 1,
    };
}

/** Durable metadata only: rows, receipts, and immutable proofs. It owns no filesystem. */
class MemoryCatalog {
    readonly rows = new Map<string, Worklet>();
    readonly receipts = new Map<string, WorkletCatalogMutationReceipt>();
    readonly proofs = new Map<string, WorkletCatalogMutationProof>();
    mutationCount = 0;
    failProofWrite = false;
    failRollbackRegistration = false;
    skipAfterCommit = false;
    readonly contract: WorkletCatalog;
    #tail: Promise<void> = Promise.resolve();
    #transactions = new AsyncLocalStorage<{
        readonly rowSnapshot: Map<string, Worklet>;
        readonly receiptSnapshot: Map<string, WorkletCatalogMutationReceipt>;
        readonly proofSnapshot: Map<string, WorkletCatalogMutationProof>;
        readonly afterCallbacks: Array<(ctx: Context) => void | Promise<void>>;
        readonly rollbackCallbacks: Array<(ctx: Context) => void | Promise<void>>;
    }>();

    constructor() {
        this.contract = {
            transaction: this.transaction.bind(this),
            afterCommit: this.afterCommit.bind(this),
            onRollback: this.onRollback.bind(this),
            list: this.list.bind(this),
            get: this.get.bind(this),
            install: this.install.bind(this),
            update: this.update.bind(this),
            revert: this.revert.bind(this),
            remove: this.remove.bind(this),
            readReceipt: this.readReceipt.bind(this),
            writeReceipt: this.writeReceipt.bind(this),
            readMutationProof: this.readMutationProof.bind(this),
            writeMutationProof: this.writeMutationProof.bind(this),
        };
        if (!Value.Check(workletCatalogSchema, this.contract)) {
            throw new Error("test catalog does not satisfy the WorkletCatalog contract");
        }
    }

    async transaction<Result>(
        transactionCtx: Context,
        work: (ctx: Context) => Promise<Result>,
    ): Promise<Result> {
        const nested = this.#transactions.getStore();
        if (nested !== undefined) return work(transactionCtx);
        const previous = this.#tail;
        let release!: () => void;
        this.#tail = new Promise<void>((resolve) => {
            release = resolve;
        });
        await previous;
        const transaction = {
            rowSnapshot: new Map(
                [...this.rows.entries()].map(([key, value]) => [key, clone(value)]),
            ),
            receiptSnapshot: new Map(
                [...this.receipts.entries()].map(([key, value]) => [key, clone(value)]),
            ),
            proofSnapshot: new Map(
                [...this.proofs.entries()].map(([key, value]) => [key, clone(value)]),
            ),
            afterCallbacks: [] as Array<(ctx: Context) => void | Promise<void>>,
            rollbackCallbacks: [] as Array<(ctx: Context) => void | Promise<void>>,
        };
        let result: Result;
        try {
            result = await this.#transactions.run(transaction, () => work(transactionCtx));
        } catch (error: unknown) {
            this.rows.clear();
            for (const [key, value] of transaction.rowSnapshot) this.rows.set(key, clone(value));
            this.receipts.clear();
            for (const [key, value] of transaction.receiptSnapshot) {
                this.receipts.set(key, clone(value));
            }
            this.proofs.clear();
            for (const [key, value] of transaction.proofSnapshot) {
                this.proofs.set(key, clone(value));
            }
            for (const callback of transaction.rollbackCallbacks.splice(0)) {
                await Promise.resolve(callback(root)).catch(() => undefined);
            }
            transaction.afterCallbacks.length = 0;
            release();
            throw error;
        }
        release();
        if (this.skipAfterCommit) {
            this.skipAfterCommit = false;
            transaction.afterCallbacks.length = 0;
            transaction.rollbackCallbacks.length = 0;
            return result;
        }
        // Post-commit callbacks run after the durable snapshot is committed.
        // A callback rejection is observable to the test caller, but it must
        // never re-enter the rollback branch or restore committed rows.
        for (const callback of transaction.afterCallbacks.splice(0)) {
            await callback(root);
        }
        transaction.rollbackCallbacks.length = 0;
        return result;
    }

    afterCommit(_ctx: Context, callback: (ctx: Context) => void | Promise<void>): void {
        const transaction = this.#transactions.getStore();
        if (transaction === undefined) throw new Error("afterCommit outside a transaction");
        transaction.afterCallbacks.push(callback);
    }

    onRollback(_ctx: Context, callback: (ctx: Context) => void | Promise<void>): void {
        if (this.failRollbackRegistration) {
            throw new Error("catalog rollback registration failed");
        }
        const transaction = this.#transactions.getStore();
        if (transaction === undefined) throw new Error("onRollback outside a transaction");
        transaction.rollbackCallbacks.push(callback);
    }

    async list(_ctx: Context, query: WorkletListQuery): Promise<WorkletListPage> {
        const limit = query.limit ?? 1;
        const start = query.cursor ?? 0;
        const worklets = [...this.rows.values()]
            .sort((left, right) => left.name.localeCompare(right.name))
            .slice(start, start + limit)
            .map(clone);
        const next = start + worklets.length;
        const previousCursor = start > 0 ? Math.max(0, start - limit) : undefined;
        if (next < this.rows.size) {
            return {
                worklets,
                limit,
                hasMore: true,
                nextCursor: next,
                ...(previousCursor === undefined ? {} : { previousCursor }),
            };
        }
        return {
            worklets,
            limit,
            hasMore: false,
            ...(previousCursor === undefined ? {} : { previousCursor }),
        };
    }

    async get(_ctx: Context, name: string): Promise<Worklet | undefined> {
        const row = this.rows.get(name);
        return row === undefined ? undefined : clone(row);
    }

    async install(
        _ctx: Context,
        input: WorkletCatalogInstallInput,
    ): Promise<Extract<WorkletCatalogMutationResult, { operation: "install" }>> {
        if (this.rows.has(input.name)) throw new Error("already installed");
        this.mutationCount += 1;
        const version = input.initialVersion;
        const worklet: Worklet = {
            name: input.name,
            ownerAgentId: input.ownerAgentId,
            currentVersion: 1,
            operations: clone(version.operations),
            versions: [clone(version)],
            createdAt: version.createdAt,
            updatedAt: version.createdAt,
        };
        this.rows.set(worklet.name, clone(worklet));
        return {
            operation: "install",
            name: worklet.name,
            operationId: input.operationId,
            targetVersion: 1,
            currentVersion: 1,
            changed: true,
            worklet: clone(worklet),
        };
    }

    async update(
        _ctx: Context,
        name: string,
        input: WorkletCatalogUpdateInput,
    ): Promise<Extract<WorkletCatalogMutationResult, { operation: "update" }>> {
        const existing = this.rows.get(name);
        if (existing === undefined) throw new Error("missing");
        this.mutationCount += 1;
        const version = {
            version: input.version,
            sourceRef: input.sourceRef,
            changeDescription: input.changeDescription,
            operations: clone(input.operations),
            createdAt: input.createdAt,
            operationId: input.operationId,
        };
        const worklet: Worklet = {
            ...clone(existing),
            currentVersion: input.version,
            operations: clone(input.operations),
            versions: [...clone(existing.versions), version],
            updatedAt: input.createdAt,
        };
        this.rows.set(name, clone(worklet));
        return {
            operation: "update",
            name,
            operationId: input.operationId,
            targetVersion: input.version,
            currentVersion: input.version,
            changed: true,
            worklet: clone(worklet),
        };
    }

    async revert(
        _ctx: Context,
        name: string,
        input: WorkletCatalogRevertInput,
    ): Promise<Extract<WorkletCatalogMutationResult, { operation: "revert" }>> {
        const existing = this.rows.get(name);
        if (existing === undefined) throw new Error("missing");
        this.mutationCount += 1;
        const version = existing.versions.find((item) => item.version === input.version);
        if (version === undefined) throw new Error("version missing");
        const changed = existing.currentVersion !== input.version;
        const worklet: Worklet = {
            ...clone(existing),
            currentVersion: input.version,
            operations: clone(version.operations),
        };
        this.rows.set(name, clone(worklet));
        return {
            operation: "revert",
            name,
            operationId: input.operationId,
            targetVersion: input.version,
            currentVersion: input.version,
            changed,
            worklet: clone(worklet),
        };
    }

    async remove(
        _ctx: Context,
        name: string,
        operationId: string,
    ): Promise<Extract<WorkletCatalogMutationResult, { operation: "remove" }>> {
        this.mutationCount += 1;
        const changed = this.rows.delete(name);
        return {
            operation: "remove",
            name,
            operationId,
            targetVersion: 0,
            currentVersion: 0,
            changed,
            removed: changed,
        };
    }

    async readReceipt(_ctx: Context, operationId: string) {
        const receipt = this.receipts.get(operationId);
        return receipt === undefined ? undefined : clone(receipt);
    }

    async writeReceipt(_ctx: Context, receipt: WorkletCatalogMutationReceipt): Promise<void> {
        if (this.receipts.has(receipt.operationId)) {
            throw new Error("catalog receipt already exists");
        }
        this.receipts.set(receipt.operationId, clone(receipt));
    }

    async readMutationProof(_ctx: Context, operationId: string) {
        const proof = this.proofs.get(operationId);
        return proof === undefined ? undefined : clone(proof);
    }

    async writeMutationProof(_ctx: Context, proof: WorkletCatalogMutationProof): Promise<void> {
        if (this.failProofWrite) throw new Error("catalog proof write failed");
        if (this.proofs.has(proof.operationId)) {
            throw new Error("catalog proof already exists");
        }
        this.proofs.set(proof.operationId, clone(proof));
    }
}

class MemoryRuntime {
    readonly statuses = new Map<string, WorkletStatus>();
    readonly logs = new Map<string, string[]>();
    readonly invocations: WorkletRuntimeInvocationRequest[] = [];
    logPageOverride: WorkletLogPage | undefined;
    readonly contract: WorkletRuntime;

    constructor() {
        this.contract = {
            status: this.status.bind(this),
            readLogs: this.readLogs.bind(this),
            invokeOperation: this.invokeOperation.bind(this),
        };
        if (!Value.Check(workletRuntimeSchema, this.contract)) {
            throw new Error("test runtime does not satisfy the WorkletRuntime contract");
        }
    }

    async status(_ctx: Context, name: string): Promise<WorkletStatus> {
        return clone(this.statuses.get(name) ?? { name, state: "asleep", at: 1 });
    }

    async readLogs(_ctx: Context, query: WorkletRuntimeLogQuery): Promise<WorkletLogPage> {
        if (this.logPageOverride !== undefined) return clone(this.logPageOverride);
        const all = this.logs.get(query.name) ?? [];
        const start =
            query.from === "end" ? Math.max(0, all.length - query.limit) : query.cursor ?? 0;
        const lines = all.slice(start, start + query.limit).map((text, index) => ({
            position: start + index,
            text: text.slice(0, query.maxLineCharacters),
        }));
        const next = start + lines.length;
        const previousCursor = start > 0 ? Math.max(0, start - query.limit) : undefined;
        if (next < all.length) {
            if (start === 0) {
                return {
                    name: query.name,
                    cursor: 0,
                    lines,
                    totalLines: all.length,
                    nextCursor: next,
                };
            }
            return {
                name: query.name,
                cursor: start,
                lines,
                totalLines: all.length,
                nextCursor: next,
                previousCursor: previousCursor!,
            };
        }
        if (start === 0) {
            return {
                name: query.name,
                cursor: 0,
                lines,
                totalLines: all.length,
            };
        }
        return {
            name: query.name,
            cursor: start,
            lines,
            totalLines: all.length,
            previousCursor: previousCursor!,
        };
    }

    async invokeOperation(
        _ctx: Context,
        request: WorkletRuntimeInvocationRequest,
    ): Promise<WorkletInvocationResult> {
        this.invocations.push(clone(request));
        const result = {
            name: request.name,
            operation: request.operation,
            result: request.arguments,
        };
        if (!Value.Check(workletInvocationResultSchema, result)) {
            throw new Error("invalid invocation fixture");
        }
        return result;
    }
}

interface Harness {
    catalog: MemoryCatalog;
    runtime: MemoryRuntime;
    feature: Feature;
    installRoot: string;
    srcPing: string;
    srcEcho: string;
}

async function setup(
    overrides: Partial<ConstructorParameters<typeof Feature>[0]> = {},
): Promise<Harness> {
    const catalog = new MemoryCatalog();
    const runtime = new MemoryRuntime();
    const installRoot = join(await tempDir("worklet-root-"), "worklets");
    const srcPing = await makeSource([{ name: "ping", description: "Return a ping." }]);
    const srcEcho = await makeSource([{ name: "echo", description: "Echo arguments." }]);
    const feature = makeFeature(catalog, runtime, installRoot, overrides);
    return { catalog, runtime, feature, installRoot, srcPing, srcEcho };
}

function makeFeature(
    catalog: MemoryCatalog,
    runtime: MemoryRuntime,
    installRoot: string,
    overrides: Partial<ConstructorParameters<typeof Feature>[0]> = {},
): Feature {
    return new Feature({
        catalog: catalog.contract,
        runtime: runtime.contract,
        installRoot,
        idFactory: (_ctx, agentId) => `id-${agentId}-${randomUUID()}`,
        eventIdFactory: (_ctx, agentId) => `event-${agentId}-${randomUUID()}`,
        clock: () => 500,
        ...overrides,
    });
}

function scopeFor(id: string): AgentFeatureScope {
    return { agent: { id } } as AgentFeatureScope;
}

describe("WorkletsFeature", () => {
    it("installs version 1 with the Data folder and the icon on disk", async () => {
        const { feature, installRoot, srcPing } = await setup();
        const installed = await feature.install(root, "agent-a", {
            name: "disk-worker",
            sourceRef: srcPing,
            operationId: "disk-install",
        });
        expect(installed.currentVersion).toBe(1);
        expect(installed.operations.map((operation) => operation.name)).toEqual(["ping"]);

        const base = join(installRoot, "disk-worker");
        expect((await lstat(join(base, "v1"))).isDirectory()).toBe(true);
        expect((await lstat(join(base, "Data"))).isDirectory()).toBe(true);
        expect((await lstat(join(base, "favicon.png"))).isFile()).toBe(true);
        expect(await readFile(join(base, "v1", "index.ts"), "utf8")).toContain("run");
        expect(await exists(join(base, "v2"))).toBe(false);
    });

    it("adds v2 on the second install while keeping v1 and Data intact", async () => {
        const { feature, installRoot, srcPing, srcEcho } = await setup();
        await feature.install(root, "agent-a", {
            name: "kept-worker",
            sourceRef: srcPing,
            operationId: "kept-install",
        });
        const base = join(installRoot, "kept-worker");
        await writeFile(join(base, "Data", "state.json"), '{"kept":true}');

        const updated = await feature.update(root, "agent-a", "kept-worker", {
            sourceRef: srcEcho,
            changeDescription: "Add echo",
            operationId: "kept-update",
        });
        expect(updated.currentVersion).toBe(2);
        expect((await lstat(join(base, "v1"))).isDirectory()).toBe(true);
        expect((await lstat(join(base, "v2"))).isDirectory()).toBe(true);
        expect(await readFile(join(base, "Data", "state.json"), "utf8")).toBe('{"kept":true}');
        expect(updated.operations.map((operation) => operation.name)).toEqual(["echo"]);
    });

    it("reverts by moving the pointer without deleting any version files", async () => {
        const { feature, installRoot, srcPing, srcEcho } = await setup();
        await feature.install(root, "agent-a", {
            name: "revert-worker",
            sourceRef: srcPing,
            operationId: "revert-install",
        });
        await feature.update(root, "agent-a", "revert-worker", {
            sourceRef: srcEcho,
            changeDescription: "Add echo",
            operationId: "revert-update",
        });
        const base = join(installRoot, "revert-worker");
        await writeFile(join(base, "Data", "state.json"), '{"survives":true}');
        const reverted = await feature.revert(root, "agent-a", "revert-worker", {
            version: 1,
            operationId: "revert-back",
        });
        expect(reverted.currentVersion).toBe(1);
        expect(await exists(join(base, "v1"))).toBe(true);
        expect(await exists(join(base, "v2"))).toBe(true);
        expect(await exists(join(base, "Data"))).toBe(true);
        expect(await readFile(join(base, "Data", "state.json"), "utf8")).toBe(
            '{"survives":true}',
        );
    });

    it("refuses to revert a version whose on-disk provenance was changed", async () => {
        const { feature, installRoot, srcPing, srcEcho } = await setup();
        await feature.install(root, "agent-a", {
            name: "provenance-worker",
            sourceRef: srcPing,
            operationId: "provenance-install",
        });
        await feature.update(root, "agent-a", "provenance-worker", {
            sourceRef: srcEcho,
            changeDescription: "Add echo",
            operationId: "provenance-update",
        });
        await writeFile(
            join(installRoot, "provenance-worker", "v1", ".rig-worklet-version.json"),
            JSON.stringify({ version: 1, sourceRef: srcEcho }),
        );
        await expect(
            feature.revert(root, "agent-a", "provenance-worker", {
                version: 1,
                operationId: "provenance-revert",
            }),
        ).rejects.toThrow("mismatched provenance");
    });

    it("rolls the files back when the install fails after staging", async () => {
        const { feature, catalog, installRoot, srcPing } = await setup();
        catalog.failProofWrite = true;
        await expect(
            feature.install(root, "agent-a", {
                name: "rollback-worker",
                sourceRef: srcPing,
                operationId: "rollback-install",
            }),
        ).rejects.toThrow("catalog proof write failed");
        expect(catalog.rows.size).toBe(0);
        expect(await exists(join(installRoot, "rollback-worker"))).toBe(false);
    });

    it("cleans a staged revert when a later catalog write fails", async () => {
        const { feature, catalog, installRoot, srcPing, srcEcho } = await setup();
        await feature.install(root, "agent-a", {
            name: "revert-proof-failure",
            sourceRef: srcPing,
            operationId: "revert-proof-install",
        });
        await feature.update(root, "agent-a", "revert-proof-failure", {
            sourceRef: srcEcho,
            changeDescription: "Add echo",
            operationId: "revert-proof-update",
        });
        catalog.failProofWrite = true;
        await expect(
            feature.revert(root, "agent-a", "revert-proof-failure", {
                version: 1,
                operationId: "revert-proof-failure",
            }),
        ).rejects.toThrow("catalog proof write failed");
        expect(catalog.rows.get("revert-proof-failure")?.currentVersion).toBe(2);
        expect(await exists(join(installRoot, "revert-proof-failure", "v1"))).toBe(true);
        expect(await exists(join(installRoot, "revert-proof-failure", "v2"))).toBe(true);
    });

    it("cleans a staged revert when its transactional listener fails", async () => {
        const { catalog, runtime, installRoot, srcPing, srcEcho } = await setup();
        const feature = makeFeature(catalog, runtime, installRoot);
        await feature.install(root, "agent-a", {
            name: "revert-listener-failure",
            sourceRef: srcPing,
            operationId: "revert-listener-install",
        });
        await feature.update(root, "agent-a", "revert-listener-failure", {
            sourceRef: srcEcho,
            changeDescription: "Add echo",
            operationId: "revert-listener-update",
        });
        const rejecting = makeFeature(catalog, runtime, installRoot, {
            listener: {
                onEventTransactional: () => {
                    throw new Error("revert listener rejected");
                },
            },
        });
        await expect(
            rejecting.revert(root, "agent-a", "revert-listener-failure", {
                version: 1,
                operationId: "revert-listener-failure",
            }),
        ).rejects.toThrow("revert listener rejected");
        expect(catalog.rows.get("revert-listener-failure")?.currentVersion).toBe(2);
        expect(await exists(join(installRoot, "revert-listener-failure", "v1"))).toBe(true);
        expect(await exists(join(installRoot, "revert-listener-failure", "v2"))).toBe(true);
    });

    it("cleans a staged revert when an outer transaction rolls back", async () => {
        const { feature, catalog, installRoot, srcPing, srcEcho } = await setup();
        await feature.install(root, "agent-a", {
            name: "revert-outer-failure",
            sourceRef: srcPing,
            operationId: "revert-outer-install",
        });
        await feature.update(root, "agent-a", "revert-outer-failure", {
            sourceRef: srcEcho,
            changeDescription: "Add echo",
            operationId: "revert-outer-update",
        });
        await expect(
            catalog.transaction(root, async (txCtx) => {
                await feature.revert(root, "agent-a", "revert-outer-failure", {
                    version: 1,
                    operationId: "revert-outer-failure",
                });
                throw new Error("revert outer rollback");
            }),
        ).rejects.toThrow("revert outer rollback");
        expect(catalog.rows.get("revert-outer-failure")?.currentVersion).toBe(2);
        expect(await exists(join(installRoot, "revert-outer-failure", "v1"))).toBe(true);
        expect(await exists(join(installRoot, "revert-outer-failure", "v2"))).toBe(true);
    });

    it("cleans a stage when rollback registration throws", async () => {
        const { feature, catalog, installRoot, srcPing } = await setup();
        catalog.failRollbackRegistration = true;
        await expect(
            feature.install(root, "agent-a", {
                name: "registration-failure",
                sourceRef: srcPing,
                operationId: "registration-failure",
            }),
        ).rejects.toThrow("rollback registration failed");
        expect(catalog.rows.size).toBe(0);
        expect(await exists(join(installRoot, "registration-failure"))).toBe(false);
    });

    it("refuses a symbolic link that escapes the source tree", async () => {
        const { feature, installRoot } = await setup();
        const outside = await tempDir("worklet-outside-");
        await writeFile(join(outside, "secret.txt"), "secret");
        const source = await makeSource([{ name: "ping" }], {
            extra: async (dir) => {
                await symlink(join(outside, "secret.txt"), join(dir, "escape"));
            },
        });
        await expect(
            feature.install(root, "agent-a", {
                name: "symlink-worker",
                sourceRef: source,
                operationId: "symlink-install",
            }),
        ).rejects.toThrow("symbolic link");
        expect(await exists(join(installRoot, "symlink-worker"))).toBe(false);
    });

    it("refuses a pre-existing symlink at the worklet name without touching its target", async () => {
        const { feature, installRoot, srcPing } = await setup();
        const outside = await tempDir("worklet-install-target-");
        await writeFile(join(outside, "keep.txt"), "do not delete");
        await mkdir(installRoot, { recursive: true });
        await symlink(outside, join(installRoot, "linked-worker"));

        await expect(
            feature.install(root, "agent-a", {
                name: "linked-worker",
                sourceRef: srcPing,
                operationId: "linked-worker-install",
            }),
        ).rejects.toThrow("real folder");
        expect(await readFile(join(outside, "keep.txt"), "utf8")).toBe("do not delete");
        expect(await exists(join(outside, "Data"))).toBe(false);
    });

    it("rejects a source ancestor of the install root before creating a worklet folder", async () => {
        const { feature, installRoot } = await setup();
        const sourceAncestor = dirname(installRoot);
        await expect(
            feature.install(root, "agent-a", {
                name: "ancestor-worker",
                sourceRef: sourceAncestor,
                operationId: "ancestor-install",
            }),
        ).rejects.toThrow("contain one another");
        expect(await exists(join(installRoot, "ancestor-worker"))).toBe(false);
    });

    it("does not reuse a stale file at an existing version path", async () => {
        const { feature, installRoot, srcPing } = await setup();
        const base = join(installRoot, "stale-worker");
        await mkdir(join(base, "Data"), { recursive: true });
        await writeFile(join(base, "v1"), "stale code");
        await expect(
            feature.install(root, "agent-a", {
                name: "stale-worker",
                sourceRef: srcPing,
                operationId: "stale-install",
            }),
        ).rejects.toThrow("not a real folder");
        expect(await readFile(join(base, "v1"), "utf8")).toBe("stale code");
    });

    it("reconciles crash leftovers before copying a new version", async () => {
        const { feature, installRoot, srcPing } = await setup();
        const base = join(installRoot, "crash-worker");
        await mkdir(join(base, "Data"), { recursive: true });
        await writeFile(join(base, "Data", "state.txt"), "durable");
        await mkdir(join(base, ".v1-deadbeef"), { recursive: true });
        await writeFile(join(base, ".v1-deadbeef", "partial.ts"), "partial");
        await writeFile(join(base, ".favicon-deadbeef.png"), "partial icon");
        await writeFile(join(base, ".favicon-orphan-deadbeef.png"), "orphan icon");

        await feature.install(root, "agent-a", {
            name: "crash-worker",
            sourceRef: srcPing,
            operationId: "crash-recovery-install",
        });
        const entries = await readdir(base);
        expect(entries.some((entry) => entry.startsWith(".v"))).toBe(false);
        expect(entries.some((entry) => entry.startsWith(".favicon-"))).toBe(false);
        expect(await readFile(join(base, "Data", "state.txt"), "utf8")).toBe("durable");
        expect(await exists(join(base, "v1"))).toBe(true);
    });

    it("reconciles a final version stranded before its catalog mutation", async () => {
        const { feature, installRoot, srcPing } = await setup();
        const base = join(installRoot, "stranded-worker");
        await mkdir(join(base, "Data"), { recursive: true });
        await mkdir(join(base, "v1"));
        await writeFile(join(base, "v1", "index.ts"), "orphaned");

        await feature.install(root, "agent-a", {
            name: "stranded-worker",
            sourceRef: srcPing,
            operationId: "stranded-retry",
        });

        expect(await readFile(join(base, "v1", "index.ts"), "utf8")).toContain("run");
    });

    it("rejects hard-linked source files", async () => {
        const { feature, installRoot } = await setup();
        const source = await makeSource([{ name: "ping" }], {
            extra: async (dir) => {
                await link(join(dir, "index.ts"), join(dir, "second-link.ts"));
            },
        });
        await expect(
            feature.install(root, "agent-a", {
                name: "hardlink-worker",
                sourceRef: source,
                operationId: "hardlink-install",
            }),
        ).rejects.toThrow("single-link");
        expect(await exists(join(installRoot, "hardlink-worker"))).toBe(false);
    });

    it("bounds hostile deep and wide source trees", async () => {
        const { feature, installRoot } = await setup();
        const deepSource = await makeSource([{ name: "ping" }], {
            extra: async (dir) => {
                let current = dir;
                for (let index = 0; index < WORKLET_SOURCE_MAX_DEPTH + 4; index += 1) {
                    current = join(current, `nested-${index}`);
                    await mkdir(current);
                }
                await writeFile(join(current, "too-deep.ts"), "deep");
            },
        });
        await expect(
            feature.install(root, "agent-a", {
                name: "deep-worker",
                sourceRef: deepSource,
                operationId: "deep-install",
            }),
        ).rejects.toThrow("depth");

        const wideSource = await makeSource([{ name: "ping" }], {
            extra: async (dir) => {
                await Promise.all(
                    Array.from({ length: WORKLET_SOURCE_MAX_FILES - 2 }, (_, index) =>
                        mkdir(join(dir, `wide-${index}`)),
                    ),
                );
            },
        });
        await expect(
            feature.install(root, "agent-a", {
                name: "wide-worker",
                sourceRef: wideSource,
                operationId: "wide-install",
            }),
        ).rejects.toThrow("10,000");
        expect(await exists(join(installRoot, "wide-worker"))).toBe(false);
    }, 20_000);

    it("refuses a source tree over the file-size bound", async () => {
        const { feature, installRoot } = await setup();
        const source = await makeSource([{ name: "ping" }], {
            extra: async (dir) => {
                await writeFile(
                    join(dir, "huge.bin"),
                    Buffer.alloc(WORKLET_SOURCE_MAX_FILE_BYTES + 1),
                );
            },
        });
        await expect(
            feature.install(root, "agent-a", {
                name: "huge-worker",
                sourceRef: source,
                operationId: "huge-install",
            }),
        ).rejects.toThrow("10 MiB");
        expect(await exists(join(installRoot, "huge-worker"))).toBe(false);
    });

    it("keeps a worklet's Data folder when it is removed", async () => {
        const { feature, installRoot, srcPing } = await setup();
        await feature.install(root, "agent-a", {
            name: "removed-worker",
            sourceRef: srcPing,
            operationId: "removed-install",
        });
        const base = join(installRoot, "removed-worker");
        await writeFile(join(base, "Data", "keep.txt"), "keep");
        expect(await feature.remove(root, "agent-a", "removed-worker", "removed-remove")).toBe(true);
        expect(await exists(join(base, "v1"))).toBe(false);
        expect(await exists(join(base, "favicon.png"))).toBe(false);
        expect(await readFile(join(base, "Data", "keep.txt"), "utf8")).toBe("keep");
    });

    it("shares behavior between public methods and common tools", async () => {
        const { feature, catalog, runtime, srcPing, srcEcho } = await setup();

        const installed = await feature.install(root, "agent-a", {
            name: "weather-worker",
            sourceRef: srcPing,
            operationId: "install-a",
        });
        expect(installed.currentVersion).toBe(1);

        const tools = feature.tools(root, scopeFor("agent-a"));
        expect(tools.map((tool) => tool.name)).toEqual([
            "install_worklet",
            "list_worklets",
            "get_worklet",
            "update_worklet",
            "revert_worklet",
            "remove_worklet",
            "get_worklet_status",
            "read_worklet_logs",
            "invoke_worklet_operation",
        ]);

        const worldPersistence = new InMemoryPersistence();
        const toolCtx = withAgentKV(root, new AgentKV(worldPersistence, "call."));
        const updateTool = tools.find((tool) => tool.name === "update_worklet");
        expect(updateTool).toBeDefined();
        const updateResult = await updateTool!.execute(toolCtx, {
            name: "weather-worker",
            sourceRef: srcEcho,
            changeDescription: "Add echo operation",
        });
        expect(updateResult).toMatchObject({ worklet: { currentVersion: 2 } });
        expect(runtime.invocations).toHaveLength(0);

        const installTool = tools.find((tool) => tool.name === "install_worklet");
        expect(installTool).toBeDefined();
        const installInput = { name: "tool-worker", sourceRef: srcPing };
        const mutationsBeforeReplay = catalog.mutationCount;
        await installTool!.execute(toolCtx, installInput);
        await installTool!.execute(toolCtx, installInput);
        expect(catalog.mutationCount).toBe(mutationsBeforeReplay + 1);
    });

    it("persists versions, proofs, and receipts across a fresh feature instance", async () => {
        const { catalog, runtime, feature, installRoot, srcPing, srcEcho } = await setup();
        await feature.install(root, "agent-a", {
            name: "state-worker",
            sourceRef: srcPing,
            operationId: "install-1",
        });
        await feature.update(root, "agent-a", "state-worker", {
            sourceRef: srcEcho,
            changeDescription: "Add echo",
            operationId: "update-1",
        });
        const fresh = makeFeature(catalog, runtime, installRoot);
        const detail = await fresh.get(root, "agent-a", "state-worker");
        expect(detail?.currentVersion).toBe(2);
        expect(detail?.versions.map((version) => version.changeDescription)).toEqual([
            "Initial install",
            "Add echo",
        ]);
        expect(catalog.receipts.get("update-1")).toBeDefined();
        expect(catalog.proofs.get("update-1")).toBeDefined();
        const retainedProof = catalog.proofs.get("update-1")!;
        const retainedReceipt = catalog.receipts.get("update-1")!;
        expect(
            "worklet" in retainedProof.result &&
            "versions" in retainedProof.result.worklet,
        ).toBe(false);
        expect(
            "worklet" in retainedReceipt.result &&
            "version" in retainedReceipt.result &&
            retainedReceipt.result.version.version,
        ).toBe(2);
        expect(
            "historyOperationId" in retainedReceipt.result &&
            retainedReceipt.result.historyOperationId,
        ).toBe("install-1");
    });

    it("lists and pages a maximum legal worklet record", async () => {
        const { catalog, feature } = await setup();
        const maximum = makeMaximumWorklet("maximum-worker");
        catalog.rows.set(maximum.name, clone(maximum));

        const page = await feature.listPage(root, "agent-a", { limit: 1 });
        expect(page.worklets).toEqual([maximum]);
        const detailPage = await feature.getPage(root, "agent-a", maximum.name, {
            limit: 1,
        });
        if (detailPage.worklet === null) throw new Error("maximum worklet was not found");
        expect(detailPage.worklet.name).toBe(maximum.name);
        expect(detailPage.detail.length).toBe(1);
    });

    it("keeps receipts bounded across the maximum legal version history", async () => {
        const { catalog, feature } = await setup();
        const maximumSource = await makeSource(maximumOperations());
        await feature.install(root, "agent-a", {
            name: "maximum-history-worker",
            sourceRef: maximumSource,
            operationId: "maximum-history-install",
        });
        const changeDescription = "c".repeat(MAX_WORKLET_CHANGE_DESCRIPTION_LENGTH);
        for (let version = 2; version <= MAX_WORKLET_VERSIONS; version += 1) {
            await feature.update(root, "agent-a", "maximum-history-worker", {
                sourceRef: maximumSource,
                changeDescription,
                operationId: `maximum-history-update-${version}`,
            });
        }

        expect(catalog.rows.get("maximum-history-worker")?.versions).toHaveLength(
            MAX_WORKLET_VERSIONS,
        );
        const receiptBytes = [...catalog.receipts.values()].reduce(
            (total, receipt) =>
                total + new TextEncoder().encode(JSON.stringify(receipt)).byteLength,
            0,
        );
        expect(receiptBytes).toBeLessThan(MAX_WORKLET_RECORD_BYTES * 2);
        for (const receipt of catalog.receipts.values()) {
            expect("versions" in receipt.result).toBe(false);
        }

        const fresh = makeFeature(
            catalog,
            new MemoryRuntime(),
            join(await tempDir("worklet-root-replay-"), "worklets"),
        );
        const replayed = await fresh.update(root, "agent-a", "maximum-history-worker", {
            sourceRef: maximumSource,
            changeDescription,
            operationId: "maximum-history-update-100",
        });
        expect(replayed.currentVersion).toBe(MAX_WORKLET_VERSIONS);
    });

    it("recovers removal cleanup by replay after the post-commit callback is lost", async () => {
        const { catalog, runtime, feature, installRoot, srcPing } = await setup();
        await feature.install(root, "agent-a", {
            name: "cleanup-recovery-worker",
            sourceRef: srcPing,
            operationId: "cleanup-recovery-install",
        });
        catalog.skipAfterCommit = true;
        await feature.remove(root, "agent-a", "cleanup-recovery-worker", "cleanup-recovery-remove");
        expect(await exists(join(installRoot, "cleanup-recovery-worker", "v1"))).toBe(true);

        const fresh = makeFeature(catalog, runtime, installRoot);
        await fresh.remove(root, "agent-a", "cleanup-recovery-worker", "cleanup-recovery-remove");
        expect(await exists(join(installRoot, "cleanup-recovery-worker", "v1"))).toBe(false);
        expect(await exists(join(installRoot, "cleanup-recovery-worker", "Data"))).toBe(true);
    });

    it("keeps catalog receipts and proofs write-once", async () => {
        const { feature, catalog, srcPing } = await setup();
        await feature.install(root, "agent-a", {
            name: "write-once-worker",
            sourceRef: srcPing,
            operationId: "write-once-install",
        });
        const receipt = clone(catalog.receipts.get("write-once-install")!);
        const proof = clone(catalog.proofs.get("write-once-install")!);
        await expect(catalog.writeReceipt(root, receipt)).rejects.toThrow("already exists");
        await expect(catalog.writeMutationProof(root, proof)).rejects.toThrow("already exists");
        expect(catalog.receipts.get("write-once-install")).toEqual(receipt);
        expect(catalog.proofs.get("write-once-install")).toEqual(proof);
    });

    it("publishes one stable event only for changed mutations and contains post-commit failures", async () => {
        const transactional: WorkletEvent[] = [];
        const postCommit: WorkletEvent[] = [];
        const failures: unknown[] = [];
        const { feature, srcPing } = await setup({
            listener: {
                onEventTransactional: (_ctx, event) => {
                    transactional.push(event);
                },
                onEvent: (_ctx, event) => {
                    postCommit.push(event);
                    throw new Error("observer failed");
                },
            },
            onPostCommitError: (_ctx, _event, error) => {
                failures.push(error);
            },
        });
        await feature.install(root, "agent-a", {
            name: "event-worker",
            sourceRef: srcPing,
            operationId: "event-install",
        });
        await feature.revert(root, "agent-a", "event-worker", {
            version: 1,
            operationId: "event-revert-noop",
        });
        expect(transactional).toHaveLength(1);
        expect(postCommit).toHaveLength(1);
        expect(postCommit[0]).toBe(transactional[0]);
        expect(Object.isFrozen(postCommit[0])).toBe(true);
        expect(failures).toHaveLength(1);
    });

    it("removes the staged files when a transactional listener rolls back", async () => {
        const { feature, catalog, installRoot, srcPing } = await setup({
            listener: {
                onEventTransactional: () => {
                    throw new Error("reject event");
                },
            },
        });
        await expect(
            feature.install(root, "agent-a", {
                name: "listener-rollback-worker",
                sourceRef: srcPing,
                operationId: "listener-rollback-install",
            }),
        ).rejects.toThrow("reject event");
        expect(catalog.rows.size).toBe(0);
        expect(await exists(join(installRoot, "listener-rollback-worker"))).toBe(false);
    });

    it("publishes no post-commit event and rolls back files when an outer transaction rolls back", async () => {
        const transactional: WorkletEvent[] = [];
        const postCommit: WorkletEvent[] = [];
        const { feature, catalog, installRoot, srcPing } = await setup({
            listener: {
                onEventTransactional: (_ctx, event) => {
                    transactional.push(event);
                },
                onEvent: (_ctx, event) => {
                    postCommit.push(event);
                },
            },
        });
        await expect(
            catalog.transaction(root, async (txCtx) => {
                await feature.install(txCtx, "agent-a", {
                    name: "outer-rollback-worker",
                    sourceRef: srcPing,
                    operationId: "outer-rollback-install",
                });
                throw new Error("outer rollback");
            }),
        ).rejects.toThrow("outer rollback");
        expect(transactional).toHaveLength(1);
        expect(postCommit).toHaveLength(0);
        expect(catalog.rows.size).toBe(0);
        expect(await exists(join(installRoot, "outer-rollback-worker"))).toBe(false);
    });

    it("commits concurrent installs inside the injected transaction boundary", async () => {
        const { feature, catalog, installRoot, srcPing, srcEcho } = await setup();
        await catalog.transaction(root, async (txCtx) => {
            await Promise.all([
                feature.install(txCtx, "agent-a", {
                    name: "concurrent-one",
                    sourceRef: srcPing,
                    operationId: "concurrent-one-install",
                }),
                feature.install(txCtx, "agent-a", {
                    name: "concurrent-two",
                    sourceRef: srcEcho,
                    operationId: "concurrent-two-install",
                }),
            ]);
        });
        expect(catalog.rows.has("concurrent-one")).toBe(true);
        expect(catalog.rows.has("concurrent-two")).toBe(true);
        expect(await exists(join(installRoot, "concurrent-one", "v1"))).toBe(true);
        expect(await exists(join(installRoot, "concurrent-two", "v1"))).toBe(true);
    });

    it("serializes top-level catalog transactions and never rolls back committed rows after callback failure", async () => {
        const catalog = new MemoryCatalog();
        let active = 0;
        let maximumActive = 0;
        await Promise.all(
            [1, 2].map(() =>
                catalog.contract.transaction(root, async () => {
                    active += 1;
                    maximumActive = Math.max(maximumActive, active);
                    await new Promise<void>((resolve) => setTimeout(resolve, 1));
                    active -= 1;
                }),
            ),
        );
        expect(maximumActive).toBe(1);

        const persisted = makeWorklet(
            "callback-worker",
            "agent-a",
            "source-ping",
            "callback-op",
        );
        await expect(
            catalog.contract.transaction(root, async (ctx) => {
                catalog.rows.set(persisted.name, clone(persisted));
                catalog.contract.afterCommit(ctx, () => {
                    throw new Error("after-commit callback failed");
                });
            }),
        ).rejects.toThrow("after-commit callback failed");
        expect(catalog.rows.get("callback-worker")).toEqual(persisted);
    });

    it("rejects malformed persisted version and operation invariants", async () => {
        const { catalog, feature } = await setup();
        catalog.rows.set("broken-worker", {
            ...makeWorklet("broken-worker", "agent-a", "source-ping", "op-1"),
            versions: [
                {
                    ...makeWorklet("broken-worker", "agent-a", "source-ping", "op-1").versions[0]!,
                    version: 2,
                },
            ],
        });
        await expect(feature.get(root, "agent-a", "broken-worker")).rejects.toThrow("Worklet");
        const timestampBroken = makeWorklet(
            "timestamp-worker",
            "agent-a",
            "source-echo",
            "timestamp-op-2",
            2,
            1,
        );
        catalog.rows.set("timestamp-worker", timestampBroken);
        await expect(feature.get(root, "agent-a", "timestamp-worker")).rejects.toThrow(
            "timestamps",
        );
    });

    it("replays a durable mutation without repeating the catalog or filesystem side effect", async () => {
        const { feature, catalog, srcPing, srcEcho } = await setup();
        const first = await feature.install(root, "agent-a", {
            name: "replay-worker",
            sourceRef: srcPing,
            operationId: "same-install",
        });
        const mutationsAfterFirst = catalog.mutationCount;
        const second = await feature.install(root, "agent-a", {
            name: "replay-worker",
            sourceRef: srcPing,
            operationId: "same-install",
        });
        expect(second).toEqual(first);
        expect(catalog.mutationCount).toBe(mutationsAfterFirst);
        await expect(
            feature.install(root, "agent-a", {
                name: "replay-worker",
                sourceRef: srcEcho,
                operationId: "same-install",
            }),
        ).rejects.toThrow("identity");
    });

    it("rejects replay evidence that changes the normalized source request", async () => {
        const { feature, catalog, srcPing, srcEcho } = await setup();
        await feature.install(root, "agent-a", {
            name: "corrupt-source-worker",
            sourceRef: srcPing,
            operationId: "corrupt-source-install",
        });
        const receipt = clone(catalog.receipts.get("corrupt-source-install")!);
        const proof = clone(catalog.proofs.get("corrupt-source-install")!);
        if (
            !("worklet" in receipt.result) ||
            !("version" in receipt.result) ||
            proof.after === null
        ) {
            throw new Error("install fixture did not create a worklet result");
        }
        receipt.result.version.sourceRef = srcEcho;
        const corruptedWorklet: Worklet = {
            name: receipt.result.worklet.name,
            ownerAgentId: receipt.result.worklet.ownerAgentId,
            currentVersion: 1,
            operations: clone(receipt.result.version.operations),
            versions: [clone(receipt.result.version)],
            createdAt: receipt.result.worklet.createdAt,
            updatedAt: receipt.result.worklet.updatedAt,
        };
        receipt.result.worklet = workletStateIdentity(corruptedWorklet);
        if (!("worklet" in proof.result)) {
            throw new Error("install fixture did not create a proof result");
        }
        proof.result = {
            ...proof.result,
            worklet: receipt.result.worklet,
        };
        proof.after = receipt.result.worklet;
        catalog.receipts.set(receipt.operationId, receipt);
        catalog.proofs.set(proof.operationId, proof);
        await expect(
            feature.install(root, "agent-a", {
                name: "corrupt-source-worker",
                sourceRef: srcPing,
                operationId: "corrupt-source-install",
            }),
        ).rejects.toThrow("request");
    });

    it("rejects replay evidence that differs from the authoritative catalog record", async () => {
        const { feature, catalog, srcPing } = await setup();
        await feature.install(root, "agent-a", {
            name: "corrupt-record-worker",
            sourceRef: srcPing,
            operationId: "corrupt-record-install",
        });
        const receipt = clone(catalog.receipts.get("corrupt-record-install")!);
        const proof = clone(catalog.proofs.get("corrupt-record-install")!);
        if (
            !("worklet" in receipt.result) ||
            !("version" in receipt.result) ||
            proof.after === null
        ) {
            throw new Error("install fixture did not create a worklet result");
        }
        receipt.result.worklet.createdAt += 1;
        receipt.result.worklet.updatedAt += 1;
        receipt.result.version.createdAt += 1;
        const corruptedWorklet: Worklet = {
            name: receipt.result.worklet.name,
            ownerAgentId: receipt.result.worklet.ownerAgentId,
            currentVersion: 1,
            operations: clone(receipt.result.version.operations),
            versions: [clone(receipt.result.version)],
            createdAt: receipt.result.worklet.createdAt,
            updatedAt: receipt.result.worklet.updatedAt,
        };
        receipt.result.worklet = workletStateIdentity(corruptedWorklet);
        if (!("worklet" in proof.result)) {
            throw new Error("install fixture did not create a proof result");
        }
        proof.result = {
            ...proof.result,
            worklet: receipt.result.worklet,
        };
        proof.after = receipt.result.worklet;
        catalog.receipts.set(receipt.operationId, receipt);
        catalog.proofs.set(proof.operationId, proof);
        await expect(
            feature.install(root, "agent-a", {
                name: "corrupt-record-worker",
                sourceRef: srcPing,
                operationId: "corrupt-record-install",
            }),
        ).rejects.toThrow("authoritative");
    });

    it("does not let a replay apply after an intervening opposite transition", async () => {
        const { feature, catalog, srcPing } = await setup();
        await feature.install(root, "agent-a", {
            name: "opposite-worker",
            sourceRef: srcPing,
            operationId: "original-install",
        });
        await feature.remove(root, "agent-a", "opposite-worker", "remove-transition");
        await expect(
            feature.install(root, "agent-a", {
                name: "opposite-worker",
                sourceRef: srcPing,
                operationId: "original-install",
            }),
        ).resolves.toMatchObject({ name: "opposite-worker", currentVersion: 1 });
        expect(catalog.rows.has("opposite-worker")).toBe(false);
    });

    it("replays an install after removal and recreation without touching the new generation", async () => {
        const { feature, catalog, srcPing, srcEcho } = await setup();
        const original = await feature.install(root, "agent-a", {
            name: "reinstall-replay-worker",
            sourceRef: srcPing,
            operationId: "reinstall-replay-install",
        });
        await feature.remove(root, "agent-a", "reinstall-replay-worker", "reinstall-replay-remove");
        await feature.install(root, "agent-a", {
            name: "reinstall-replay-worker",
            sourceRef: srcEcho,
            operationId: "reinstall-replay-new-install",
        });
        const recreated = clone(catalog.rows.get("reinstall-replay-worker"));

        await expect(
            feature.install(root, "agent-a", {
                name: "reinstall-replay-worker",
                sourceRef: srcPing,
                operationId: "reinstall-replay-install",
            }),
        ).resolves.toEqual(original);
        expect(catalog.rows.get("reinstall-replay-worker")).toEqual(recreated);
    });

    it("replays removal after a later recreation without deleting the new record", async () => {
        const { feature, catalog, srcPing, srcEcho } = await setup();
        await feature.install(root, "agent-a", {
            name: "recreated-worker",
            sourceRef: srcPing,
            operationId: "recreated-install",
        });
        await expect(
            feature.remove(root, "agent-a", "recreated-worker", "recreated-remove"),
        ).resolves.toBe(true);
        await feature.install(root, "agent-a", {
            name: "recreated-worker",
            sourceRef: srcEcho,
            operationId: "recreated-install-2",
        });
        const current = clone(catalog.rows.get("recreated-worker"));
        await expect(
            feature.remove(root, "agent-a", "recreated-worker", "recreated-remove"),
        ).resolves.toBe(true);
        expect(catalog.rows.get("recreated-worker")).toEqual(current);
    });

    it("rejects removal replay evidence whose before proof names another worklet", async () => {
        const { feature, catalog, srcPing } = await setup();
        await feature.install(root, "agent-a", {
            name: "proof-worker",
            sourceRef: srcPing,
            operationId: "proof-install",
        });
        await feature.remove(root, "agent-a", "proof-worker", "proof-remove");
        const proof = clone(catalog.proofs.get("proof-remove")!);
        if (proof.before === null) throw new Error("remove proof did not retain before state");
        proof.before.name = "other-worker";
        catalog.proofs.set("proof-remove", proof);
        await expect(
            feature.remove(root, "agent-a", "proof-worker", "proof-remove"),
        ).rejects.toThrow("before-state name");
    });

    it("replays update and revert receipts after later opposite transitions", async () => {
        const { feature, catalog, srcPing, srcEcho } = await setup();
        await feature.install(root, "agent-a", {
            name: "version-replay-worker",
            sourceRef: srcPing,
            operationId: "version-replay-install",
        });
        const firstUpdate = await feature.update(root, "agent-a", "version-replay-worker", {
            sourceRef: srcEcho,
            changeDescription: "Add echo",
            operationId: "version-replay-update-one",
        });
        await feature.update(root, "agent-a", "version-replay-worker", {
            sourceRef: srcPing,
            changeDescription: "Change back",
            operationId: "version-replay-update-two",
        });
        await expect(
            feature.update(root, "agent-a", "version-replay-worker", {
                sourceRef: srcEcho,
                changeDescription: "Add echo",
                operationId: "version-replay-update-one",
            }),
        ).resolves.toEqual(firstUpdate);

        const firstRevert = await feature.revert(root, "agent-a", "version-replay-worker", {
            version: 1,
            operationId: "version-replay-revert-one",
        });
        await feature.revert(root, "agent-a", "version-replay-worker", {
            version: 2,
            operationId: "version-replay-revert-two",
        });
        await expect(
            feature.revert(root, "agent-a", "version-replay-worker", {
                version: 1,
                operationId: "version-replay-revert-one",
            }),
        ).resolves.toEqual(firstRevert);
        expect(catalog.rows.get("version-replay-worker")?.currentVersion).toBe(2);
    });

    it("bounds logs, invocation payloads, and declared operations", async () => {
        const catalog = new MemoryCatalog();
        const runtime = new MemoryRuntime();
        runtime.logs.set("bounded-worker", ["0123456789", "second"]);
        const installRoot = join(await tempDir("worklet-root-"), "worklets");
        const srcEcho = await makeSource([{ name: "echo", description: "Echo arguments." }]);
        const feature = makeFeature(catalog, runtime, installRoot, {
            maxLogLines: 1,
            maxLogLineCharacters: 5,
            maxLogCharacters: 10,
            maxInvocationBytes: 100,
        });
        await feature.install(root, "agent-a", {
            name: "bounded-worker",
            sourceRef: srcEcho,
            operationId: "bounded-install",
        });
        const page = await feature.readLogs(root, "agent-a", "bounded-worker", {
            limit: 1,
            maxLineCharacters: 5,
            maxCharacters: 10,
        });
        expect(page.lines[0]?.text).toBe("01234");
        await expect(
            feature.readLogs(root, "agent-a", "bounded-worker", { limit: 2 }),
        ).rejects.toThrow("bounds");
        const result = await feature.invokeOperation(root, "agent-a", {
            name: "bounded-worker",
            operation: "echo",
            arguments: { value: "ok" },
        });
        expect(result.result).toEqual({ value: "ok" });
        expect(runtime.invocations[0]?.maxBytes).toBe(100);
        await expect(
            feature.invokeOperation(root, "agent-a", "bounded-worker", "not-declared", {}),
        ).rejects.toThrow("does not declare");
    });

    it("rejects deeply nested invocation arguments before schema traversal can overflow", async () => {
        const { feature, srcEcho } = await setup();
        await feature.install(root, "agent-a", {
            name: "deep-invocation-worker",
            sourceRef: srcEcho,
            operationId: "deep-invocation-install",
        });
        let nested: Record<string, unknown> = {};
        for (let index = 0; index < 100; index += 1) {
            nested = { child: nested };
        }
        await expect(
            feature.invokeOperation(root, "agent-a", {
                name: "deep-invocation-worker",
                operation: "echo",
                arguments: nested,
            }),
        ).rejects.toThrow("maximum JSON depth");
    });

    it("rejects log pages that skip records or strand continuation", async () => {
        const { feature, runtime, srcPing } = await setup();
        await feature.install(root, "agent-a", {
            name: "invalid-log-worker",
            sourceRef: srcPing,
            operationId: "invalid-log-install",
        });
        runtime.logPageOverride = {
            name: "invalid-log-worker",
            cursor: 0,
            lines: [{ position: 1, text: "skipped" }],
            totalLines: 3,
            nextCursor: 2,
        };
        await expect(
            feature.readLogs(root, "agent-a", "invalid-log-worker", { limit: 1 }),
        ).rejects.toThrow("start");

        runtime.logPageOverride = {
            name: "invalid-log-worker",
            cursor: 0,
            lines: [{ position: 0, text: "nonterminal" }],
            totalLines: 3,
        };
        await expect(
            feature.readLogs(root, "agent-a", "invalid-log-worker", { limit: 1 }),
        ).rejects.toThrow("continuation");

        runtime.logPageOverride = {
            name: "invalid-log-worker",
            cursor: 1,
            lines: [{ position: 1, text: "latest" }],
            totalLines: 2,
        } as unknown as WorkletLogPage;
        await expect(
            feature.readLogs(root, "agent-a", "invalid-log-worker", {
                from: "end",
                limit: 1,
            }),
        ).rejects.toThrow("invalid log page");
    });

    it("rejects a middle page returned for an end log request", async () => {
        const { feature, runtime, srcPing } = await setup();
        await feature.install(root, "agent-a", {
            name: "middle-end-worker",
            sourceRef: srcPing,
            operationId: "middle-end-install",
        });
        runtime.logPageOverride = {
            name: "middle-end-worker",
            cursor: 1,
            lines: [{ position: 1, text: "middle" }],
            totalLines: 3,
            previousCursor: 0,
            nextCursor: 2,
        };
        await expect(
            feature.readLogs(root, "agent-a", "middle-end-worker", {
                from: "end",
                limit: 1,
            }),
        ).rejects.toThrow("different cursor");
    });

    it("renders runtime states as natural model-facing text", async () => {
        const { feature, runtime, srcPing } = await setup();
        await feature.install(root, "agent-a", {
            name: "status-worker",
            sourceRef: srcPing,
            operationId: "status-install",
        });
        runtime.statuses.set("status-worker", {
            name: "status-worker",
            state: "running/awake",
            at: 500,
        });
        const detail = await feature.get(root, "agent-a", "status-worker");
        expect(detail).toBeDefined();
        expect(feature.formatWorkletForModel(detail)).toContain("running and awake");
        expect(feature.formatWorkletForModel(detail)).not.toContain("running/awake");
        runtime.statuses.set("status-worker", {
            name: "status-worker",
            state: "asleep",
            at: 501,
        });
        expect(feature.formatStatusForModel(await feature.status(root, "agent-a", "status-worker")))
            .toContain("sleeping");
    });

    it("enforces bounded catalog and detail cursors", async () => {
        const { feature, srcPing } = await setup({ maxPageSize: 1, maxOutputCharacters: 256 });
        await feature.install(root, "agent-a", {
            name: "cursor-worker",
            sourceRef: srcPing,
            operationId: "cursor-install",
        });
        await expect(feature.listPage(root, "agent-a", { limit: 2 })).rejects.toThrow(
            "cannot exceed",
        );
        const emptyList = await feature.listPage(root, "agent-a", { cursor: 10, limit: 1 });
        expect(emptyList.worklets).toHaveLength(0);
        expect(emptyList.previousCursor).toBe(9);

        const detail = await feature.getPage(root, "agent-a", "cursor-worker", {
            cursor: Number.MAX_SAFE_INTEGER,
            limit: 1,
        });
        expect(detail.worklet).not.toBeNull();
        if (detail.worklet !== null) {
            expect(detail.detail).toBe("");
            expect(detail.previousCursor).toBe(detail.total);
        }
    });

    it("allows global cross-agent access by default and honors an injected restriction", async () => {
        const { catalog, runtime, feature, installRoot, srcPing } = await setup();
        await feature.install(root, "owner", {
            name: "private-worker",
            sourceRef: srcPing,
            operationId: "private-install",
        });
        expect((await feature.get(root, "other", "private-worker"))?.name).toBe(
            "private-worker",
        );
        const denied = makeFeature(catalog, runtime, installRoot, {
            authorization: () => false,
        });
        await expect(denied.get(root, "other", "private-worker")).rejects.toThrow(
            "Cross-agent",
        );
    });

    it("makes a detail page and minimum list output actionable", async () => {
        const { feature, srcPing } = await setup({ maxOutputCharacters: 256, maxPageSize: 2 });
        const name = `a${"b".repeat(40)}`;
        await feature.install(root, "agent-a", {
            name,
            sourceRef: srcPing,
            operationId: "long-install",
        });
        const page = await feature.listPage(root, "agent-a", { limit: 1 });
        expect(feature.formatPageForModel(page)).toContain(name);
        const detail = await feature.getPage(root, "agent-a", name, {
            limit: MAX_WORKLET_DETAIL_PAGE_SIZE,
        });
        expect(feature.formatDetailPageForModel(detail)).toContain(name);
        expect(detail.worklet).not.toBeNull();
    });
});
