import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Value } from "@sinclair/typebox/value";
import { createRootContext, type Context } from "@steve.kite/stdlib";
import { afterEach, describe, expect, it } from "vitest";

import {
    appletCurrentResultSchema,
    appletSchema,
    type Applet,
    type AppletImportInput,
    type AppletListPage,
} from "../../sources/applets/Applet.js";
import type { AppletEvent } from "../../sources/applets/AppletEvent.js";
import { AppletModule } from "../../sources/applets/AppletModule.js";
import type {
    AppletCatalog,
    AppletCatalogCreateResult,
    AppletCatalogMutationProof,
    AppletCatalogMutationReceipt,
    AppletCatalogMutationResult,
    AppletCatalogRemoveResult,
    AppletCatalogRevertResult,
    AppletCatalogUpdateResult,
} from "../../sources/applets/AppletStore.js";

const ctx = createRootContext().named("applets-module-test");
const temporaryDirectories: string[] = [];
const PNG_1X1 = Buffer.from("89504e470d0a1a0a0000000d494844520000000100000001", "hex");

afterEach(async () => {
    const paths = temporaryDirectories.splice(0);
    await Promise.all(paths.map(async (path) => await rm(path, { force: true, recursive: true })));
});

class FakeAppletCatalog {
    readonly rows = new Map<string, Applet>();
    readonly operationReceipts = new Map<string, AppletCatalogMutationResult>();
    readonly catalogReceipts = new Map<string, AppletCatalogMutationReceipt>();
    readonly catalogProofs = new Map<string, AppletCatalogMutationProof>();
    readonly #afterCommitCallbacks: Array<(postCommitCtx: Context) => void | Promise<void>> = [];
    readonly #rollbackCallbacks: Array<(rollbackCtx: Context) => void | Promise<void>> = [];
    #depth = 0;
    #rowsSnapshot = new Map<string, Applet>();
    #operationReceiptSnapshot = new Map<string, AppletCatalogMutationResult>();
    #catalogReceiptSnapshot = new Map<string, AppletCatalogMutationReceipt>();
    #catalogProofSnapshot = new Map<string, AppletCatalogMutationProof>();

    readonly contract: AppletCatalog = {
        transaction: this.transaction.bind(this),
        afterCommit: this.afterCommit.bind(this),
        onRollback: this.onRollback.bind(this),
        list: this.list.bind(this),
        get: this.get.bind(this),
        create: this.create.bind(this),
        update: this.update.bind(this),
        revert: this.revert.bind(this),
        remove: this.remove.bind(this),
        readReceipt: this.readReceipt.bind(this),
        writeReceipt: this.writeReceipt.bind(this),
        readMutationProof: this.readMutationProof.bind(this),
        writeMutationProof: this.writeMutationProof.bind(this),
        current: this.current.bind(this),
    };

    async transaction<Result>(
        transactionCtx: Context,
        work: (txCtx: Context) => Promise<Result>,
    ): Promise<Result> {
        if (this.#depth === 0) {
            this.#rowsSnapshot = cloneMap(this.rows);
            this.#operationReceiptSnapshot = cloneMap(this.operationReceipts);
            this.#catalogReceiptSnapshot = cloneMap(this.catalogReceipts);
            this.#catalogProofSnapshot = cloneMap(this.catalogProofs);
        }
        this.#depth++;
        try {
            const result = await work(transactionCtx);
            this.#depth--;
            if (this.#depth === 0) {
                const callbacks = this.#afterCommitCallbacks.splice(0);
                this.#rollbackCallbacks.length = 0;
                for (const callback of callbacks) await callback(transactionCtx);
            }
            return result;
        } catch (error: unknown) {
            this.#depth--;
            if (this.#depth === 0) {
                replaceMap(this.rows, this.#rowsSnapshot);
                replaceMap(this.operationReceipts, this.#operationReceiptSnapshot);
                replaceMap(this.catalogReceipts, this.#catalogReceiptSnapshot);
                replaceMap(this.catalogProofs, this.#catalogProofSnapshot);
                const callbacks = this.#rollbackCallbacks.splice(0);
                this.#afterCommitCallbacks.length = 0;
                for (const callback of callbacks) await callback(transactionCtx);
            }
            throw error;
        }
    }

    afterCommit(
        _transactionCtx: Context,
        callback: (postCommitCtx: Context) => void | Promise<void>,
    ): void {
        this.#afterCommitCallbacks.push(callback);
    }

    onRollback(
        _transactionCtx: Context,
        callback: (rollbackCtx: Context) => void | Promise<void>,
    ): void {
        this.#rollbackCallbacks.push(callback);
    }

    async list(
        _ctx: Context,
        query: { readonly limit: number; readonly cursor?: string },
    ): Promise<AppletListPage> {
        const start = query.cursor === undefined ? 0 : Number(query.cursor);
        const applets = [...this.rows.values()]
            .sort((left, right) => left.name.localeCompare(right.name))
            .slice(start, start + query.limit)
            .map((applet) => structuredClone(applet));
        const hasMore = start + applets.length < this.rows.size;
        return hasMore
            ? {
                  applets,
                  limit: query.limit,
                  hasMore: true,
                  nextCursor: String(start + applets.length),
              }
            : { applets, limit: query.limit, hasMore: false };
    }

    async get(_ctx: Context, name: string): Promise<Applet | undefined> {
        const applet = this.rows.get(name);
        return applet === undefined ? undefined : structuredClone(applet);
    }

    async create(
        _ctx: Context,
        input: Parameters<AppletCatalog["create"]>[1],
    ): Promise<AppletCatalogCreateResult> {
        const key = `create:${input.name}:${input.operationId}`;
        const receipt = this.operationReceipts.get(key);
        if (receipt !== undefined) return structuredClone(receipt) as AppletCatalogCreateResult;
        if (this.rows.has(input.name)) throw new Error("Applet already exists.");

        const applet: Applet = {
            name: input.name,
            description: input.description,
            purpose: input.purpose,
            authorSessionId: input.authorSessionId,
            allowedScopes: input.allowedScopes ?? ["global"],
            ...(input.sourceDescription === undefined
                ? {}
                : { sourceDescription: input.sourceDescription }),
            ...(input.iconThumbhash === undefined ? {} : { iconThumbhash: input.iconThumbhash }),
            ...(input.iconUrl === undefined ? {} : { iconUrl: input.iconUrl }),
            currentVersion: 1,
            versions: [structuredClone(input.initialVersion)],
            createdAt: input.initialVersion.createdAt,
            updatedAt: input.initialVersion.createdAt,
        };
        this.rows.set(applet.name, applet);
        const result: AppletCatalogCreateResult = {
            operation: "create",
            name: applet.name,
            operationId: input.operationId,
            targetVersion: 1,
            currentVersion: 1,
            changed: true,
            applet: structuredClone(applet),
        };
        this.operationReceipts.set(key, result);
        return structuredClone(result);
    }

    async update(
        _ctx: Context,
        name: string,
        input: Parameters<AppletCatalog["update"]>[2],
    ): Promise<AppletCatalogUpdateResult> {
        const key = `update:${name}:${input.operationId}`;
        const receipt = this.operationReceipts.get(key);
        if (receipt !== undefined) return structuredClone(receipt) as AppletCatalogUpdateResult;
        const current = this.rows.get(name);
        if (current === undefined) throw new Error("missing applet");
        if (input.version !== current.versions.length + 1) throw new Error("wrong target version");

        const updated = structuredClone(current);
        updated.currentVersion = input.version;
        updated.updatedAt = input.createdAt;
        updated.versions.push({
            version: input.version,
            changeDescription: input.changeDescription,
            createdAt: input.createdAt,
            operationId: input.operationId,
        });
        if (input.description !== undefined) updated.description = input.description;
        if (input.purpose !== undefined) updated.purpose = input.purpose;
        if (input.allowedScopes !== undefined) updated.allowedScopes = input.allowedScopes;
        if (input.sourceDescription !== undefined) {
            updated.sourceDescription = input.sourceDescription;
        }
        if (input.iconThumbhash !== undefined) updated.iconThumbhash = input.iconThumbhash;
        if (input.iconUrl !== undefined) updated.iconUrl = input.iconUrl;
        this.rows.set(name, updated);

        const result: AppletCatalogUpdateResult = {
            operation: "update",
            name,
            operationId: input.operationId,
            targetVersion: input.version,
            currentVersion: input.version,
            changed: true,
            applet: structuredClone(updated),
        };
        this.operationReceipts.set(key, result);
        return structuredClone(result);
    }

    async revert(
        _ctx: Context,
        name: string,
        input: Parameters<AppletCatalog["revert"]>[2],
    ): Promise<AppletCatalogRevertResult> {
        const key = `revert:${name}:${input.operationId}`;
        const receipt = this.operationReceipts.get(key);
        if (receipt !== undefined) return structuredClone(receipt) as AppletCatalogRevertResult;
        const current = this.rows.get(name);
        if (current === undefined) throw new Error("missing applet");

        const reverted = structuredClone(current);
        const changed = current.currentVersion !== input.version;
        reverted.currentVersion = input.version;
        if (changed) reverted.updatedAt++;
        this.rows.set(name, reverted);
        const result: AppletCatalogRevertResult = {
            operation: "revert",
            name,
            operationId: input.operationId,
            targetVersion: input.version,
            currentVersion: input.version,
            changed,
            applet: structuredClone(reverted),
        };
        this.operationReceipts.set(key, result);
        return structuredClone(result);
    }

    async remove(
        _ctx: Context,
        name: string,
        operationId: string,
    ): Promise<AppletCatalogRemoveResult> {
        const key = `remove:${name}:${operationId}`;
        const receipt = this.operationReceipts.get(key);
        if (receipt !== undefined) return structuredClone(receipt) as AppletCatalogRemoveResult;
        const changed = this.rows.delete(name);
        const result: AppletCatalogRemoveResult = {
            operation: "remove",
            name,
            operationId,
            targetVersion: 0,
            currentVersion: 0,
            changed,
            removed: changed,
        };
        this.operationReceipts.set(key, result);
        return structuredClone(result);
    }

    async readReceipt(
        _ctx: Context,
        operationId: string,
    ): Promise<AppletCatalogMutationReceipt | undefined> {
        const receipt = this.catalogReceipts.get(operationId);
        return receipt === undefined ? undefined : structuredClone(receipt);
    }

    async writeReceipt(_ctx: Context, receipt: AppletCatalogMutationReceipt): Promise<void> {
        this.catalogReceipts.set(receipt.operationId, structuredClone(receipt));
    }

    async readMutationProof(
        _ctx: Context,
        operationId: string,
    ): Promise<AppletCatalogMutationProof | undefined> {
        const proof = this.catalogProofs.get(operationId);
        return proof === undefined ? undefined : structuredClone(proof);
    }

    async writeMutationProof(_ctx: Context, proof: AppletCatalogMutationProof): Promise<void> {
        this.catalogProofs.set(proof.operationId, structuredClone(proof));
    }

    async current(_ctx: Context, name: string) {
        const applet = this.rows.get(name);
        return applet?.versions.find((version) => version.version === applet.currentVersion);
    }
}

function cloneMap<Key, Value>(source: ReadonlyMap<Key, Value>): Map<Key, Value> {
    return new Map([...source].map(([key, value]) => [key, structuredClone(value)]));
}

function replaceMap<Key, Value>(target: Map<Key, Value>, source: ReadonlyMap<Key, Value>): void {
    target.clear();
    for (const [key, value] of source) target.set(key, structuredClone(value));
}

interface AppletFixture {
    readonly directory: string;
    readonly rootDirectory: string;
    readonly catalog: FakeAppletCatalog;
    readonly applets: AppletModule;
    readonly source: (
        name: string,
        files: Readonly<Record<string, string | Buffer>>,
    ) => Promise<string>;
    readonly icon: (name?: string) => Promise<string>;
}

async function fixture(
    overrides: Partial<ConstructorParameters<typeof AppletModule>[0]> = {},
): Promise<AppletFixture> {
    const directory = await mkdtemp(join(tmpdir(), "rig-applet-module-"));
    temporaryDirectories.push(directory);
    const rootDirectory = join(directory, "Applets");
    const catalog = new FakeAppletCatalog();
    let operation = 0;
    let event = 0;
    let now = 100;
    const applets = new AppletModule({
        catalog: catalog.contract,
        rootDirectory,
        idFactory: () => `operation-${++operation}`,
        eventIdFactory: () => `event-${++event}`,
        authorFactory: async (_ctx, agentId) => `author-for-${agentId}`,
        clock: () => now++,
        ...overrides,
    });
    return {
        directory,
        rootDirectory,
        catalog,
        applets,
        source: async (name, files) => {
            const sourcePath = join(directory, name);
            await mkdir(sourcePath, { recursive: true });
            for (const [relativePath, content] of Object.entries(files)) {
                const target = join(sourcePath, ...relativePath.split("/"));
                await mkdir(join(target, ".."), { recursive: true });
                await writeFile(target, content);
            }
            return sourcePath;
        },
        icon: async (name = "icon.png") => {
            const iconPath = join(directory, name);
            await writeFile(iconPath, PNG_1X1);
            return iconPath;
        },
    };
}

function importInput(path: string, overrides: Partial<AppletImportInput> = {}): AppletImportInput {
    return {
        name: "demo-applet",
        description: "Demo applet",
        purpose: "test applet",
        authorSessionId: "direct-author",
        path,
        allowedScopes: ["global"],
        ...overrides,
    };
}

describe("AppletModule filesystem ownership", () => {
    it("installs a real source tree as v1 and writes identity icons beside version folders", async () => {
        const test = await fixture();
        const sourcePath = await test.source("source-v1", {
            "index.html": "<main>version one</main>",
            "assets/app.js": "console.log('v1');",
        });
        const iconPath = await test.icon();

        const created = await test.applets.import(ctx, importInput(sourcePath, { iconPath }));
        const appletDirectory = join(test.rootDirectory, "demo-applet");

        expect(Value.Check(appletSchema, created)).toBe(true);
        expect(created.currentVersion).toBe(1);
        expect(created.iconUrl).toBe("/applets/demo-applet/favicon.png");
        expect((await readdir(appletDirectory)).sort()).toEqual([
            "favicon.ico",
            "favicon.png",
            "v1",
        ]);
        expect(await readFile(join(appletDirectory, "v1", "index.html"), "utf8")).toBe(
            "<main>version one</main>",
        );
        expect(await readFile(join(appletDirectory, "v1", "assets", "app.js"), "utf8")).toBe(
            "console.log('v1');",
        );
        expect(await readFile(join(appletDirectory, "favicon.png"))).toEqual(PNG_1X1);
        const ico = await readFile(join(appletDirectory, "favicon.ico"));
        expect(ico.readUInt16LE(2)).toBe(1);
        expect(ico.subarray(22)).toEqual(PNG_1X1);
    });

    it("installs updates as the next version and reverts only the current pointer", async () => {
        const test = await fixture();
        const sourceV1 = await test.source("source-v1", {
            "index.html": "version one",
        });
        const sourceV2 = await test.source("source-v2", {
            "index.html": "version two",
            "new.css": "body { color: rebeccapurple; }",
        });

        await test.applets.import(ctx, importInput(sourceV1));
        const updated = await test.applets.update(ctx, "demo-applet", {
            path: sourceV2,
            changeDescription: "Second version",
        });

        expect(updated.currentVersion).toBe(2);
        expect(updated.versions.map((version) => version.version)).toEqual([1, 2]);
        expect(
            await readFile(join(test.rootDirectory, "demo-applet", "v1", "index.html"), "utf8"),
        ).toBe("version one");
        expect(
            await readFile(join(test.rootDirectory, "demo-applet", "v2", "index.html"), "utf8"),
        ).toBe("version two");

        const reverted = await test.applets.revert(ctx, "demo-applet", { version: 1 });
        expect(reverted.currentVersion).toBe(1);
        expect(reverted.versions.map((version) => version.version)).toEqual([1, 2]);
        expect((await readdir(join(test.rootDirectory, "demo-applet"))).sort()).toEqual([
            "v1",
            "v2",
        ]);
        await expect(test.applets.current(ctx, "agent-1", "demo-applet")).resolves.toEqual(
            reverted.versions[0],
        );
    });

    it("removes durable metadata and the complete installed applet directory", async () => {
        const test = await fixture();
        const sourcePath = await test.source("source-v1", { "index.html": "installed" });
        await test.applets.import(ctx, importInput(sourcePath));

        await expect(test.applets.remove(ctx, "demo-applet")).resolves.toBe(true);
        await expect(test.applets.get(ctx, "demo-applet")).resolves.toBeUndefined();
        await expect(readdir(join(test.rootDirectory, "demo-applet"))).rejects.toMatchObject({
            code: "ENOENT",
        });
    });

    it("keeps installed files when an outer transaction rolls removal back", async () => {
        const test = await fixture();
        const sourcePath = await test.source("source-v1", { "index.html": "still installed" });
        await test.applets.import(ctx, importInput(sourcePath));

        await expect(
            test.catalog.transaction(ctx, async (outerCtx) => {
                await test.applets.remove(outerCtx, "demo-applet");
                throw new Error("outer rollback");
            }),
        ).rejects.toThrow("outer rollback");

        await expect(test.applets.get(ctx, "demo-applet")).resolves.toBeDefined();
        await expect(
            readFile(join(test.rootDirectory, "demo-applet", "v1", "index.html"), "utf8"),
        ).resolves.toBe("still installed");
    });

    it("reads real text and binary asset bytes from an installed version", async () => {
        const test = await fixture();
        const binary = Buffer.from([0, 1, 2, 250, 255]);
        const sourcePath = await test.source("source-v1", {
            "nested/message.txt": "Hello, 世界",
            "pixel.png": binary,
        });
        await test.applets.import(ctx, importInput(sourcePath));

        await expect(
            test.applets.readAsset(ctx, {
                name: "demo-applet",
                path: "nested/message.txt",
            }),
        ).resolves.toEqual({
            name: "demo-applet",
            version: 1,
            path: "nested/message.txt",
            contentType: "text/plain; charset=utf-8",
            encoding: "utf8",
            content: "Hello, 世界",
            byteLength: Buffer.byteLength("Hello, 世界"),
        });
        await expect(
            test.applets.readAsset(ctx, { name: "demo-applet", path: "pixel.png" }),
        ).resolves.toEqual({
            name: "demo-applet",
            version: 1,
            path: "pixel.png",
            contentType: "image/png",
            encoding: "base64",
            content: binary.toString("base64"),
            byteLength: binary.byteLength,
        });
    });

    it("refuses asset traversal and symlink escapes from the installed version", async () => {
        const test = await fixture();
        const sourcePath = await test.source("source-v1", { "index.html": "safe" });
        const outsidePath = join(test.directory, "outside.js");
        await writeFile(outsidePath, "outside");
        await test.applets.import(ctx, importInput(sourcePath));
        await symlink(outsidePath, join(test.rootDirectory, "demo-applet", "v1", "escape.js"));

        await expect(
            test.applets.readAsset(ctx, {
                name: "demo-applet",
                path: "../outside.js",
            }),
        ).rejects.toThrow("path is not allowed");
        await expect(
            test.applets.readAsset(ctx, {
                name: "demo-applet",
                path: "escape.js",
            }),
        ).rejects.toThrow("path is not allowed");
    });

    it("refuses symbolic links anywhere in an imported source tree", async () => {
        const test = await fixture();
        const sourcePath = await test.source("source-with-link", { "index.html": "safe" });
        const outsidePath = join(test.directory, "outside.js");
        await writeFile(outsidePath, "outside");
        await symlink(outsidePath, join(sourcePath, "linked.js"));

        await expect(test.applets.import(ctx, importInput(sourcePath))).rejects.toThrow(
            "may not contain symbolic links",
        );
        expect(test.catalog.rows.size).toBe(0);
        await expect(readdir(join(test.rootDirectory, "demo-applet"))).rejects.toMatchObject({
            code: "ENOENT",
        });
    });

    it.each([
        {
            label: "file-count",
            files: { "one.txt": "1", "two.txt": "2" },
            bounds: { maxSourceFiles: 1 },
            message: "file-count or total-byte",
        },
        {
            label: "total-byte",
            files: { "one.txt": "12", "two.txt": "34" },
            bounds: { maxSourceBytes: 3 },
            message: "file-count or total-byte",
        },
        {
            label: "per-file-byte",
            files: { "large.txt": "12" },
            bounds: { maxSourceFileBytes: 1 },
            message: "per-file byte",
        },
    ])("enforces the $label source import bound", async ({ files, bounds, message }) => {
        const test = await fixture(bounds);
        const sourcePath = await test.source("bounded-source", files);

        await expect(test.applets.import(ctx, importInput(sourcePath))).rejects.toThrow(message);
        expect(test.catalog.rows.size).toBe(0);
        await expect(readdir(join(test.rootDirectory, "demo-applet"))).rejects.toMatchObject({
            code: "ENOENT",
        });
    });

    it("rolls back a failure after copying has begun and leaves no partial directory", async () => {
        const test = await fixture({ maxSourceFileBytes: 4 });
        const sourcePath = await test.source("partially-copyable-source", {
            "a-first.txt": "ok",
            "z-too-large.txt": "12345",
        });

        await expect(test.applets.import(ctx, importInput(sourcePath))).rejects.toThrow(
            "per-file byte",
        );
        expect(test.catalog.rows.size).toBe(0);
        expect(await readdir(test.rootDirectory)).toEqual([]);
    });

    it("rolls staged files back when the transactional listener rejects the import", async () => {
        const events: AppletEvent[] = [];
        const test = await fixture({
            listener: {
                onEventTransactional: (_ctx, event) => {
                    events.push(event);
                    throw new Error("listener failed");
                },
            },
        });
        const sourcePath = await test.source("source-v1", { "index.html": "staged" });

        await expect(test.applets.import(ctx, importInput(sourcePath))).rejects.toThrow(
            "listener failed",
        );
        expect(events).toHaveLength(1);
        expect(test.catalog.rows.size).toBe(0);
        expect(await readdir(test.rootDirectory)).toEqual([]);
    });

    it("replays explicit durable operation identities without importing another version", async () => {
        const test = await fixture();
        const sourcePath = await test.source("source-v1", { "index.html": "stable" });
        const request = importInput(sourcePath, { operationId: "durable-create" });

        const created = await test.applets.import(ctx, request);
        await expect(test.applets.import(ctx, request)).resolves.toEqual(created);
        await expect(
            test.applets.import(ctx, { ...request, description: "changed request" }),
        ).rejects.toThrow("reused with different input");
        expect(await readdir(join(test.rootDirectory, "demo-applet"))).toEqual(["v1"]);
    });

    it("keeps direct operations and the eight common tools on the same catalog and filesystem", async () => {
        const test = await fixture();
        const sourcePath = await test.source("source-v1", { "index.html": "from tool" });
        const tools = test.applets.tools(ctx, { agent: { id: "agent-1" } } as never);

        expect(tools.map((tool) => tool.name)).toEqual([
            "create_applet",
            "import_applet",
            "list_applets",
            "get_applet",
            "update_applet",
            "revert_applet",
            "remove_applet",
            "read_applet_asset",
        ]);
        const created = await tools[0]!.execute(ctx, {
            name: "demo-applet",
            description: "Demo applet",
            purpose: "test applet",
            path: sourcePath,
        });
        expect(created.applet.authorSessionId).toBe("author-for-agent-1");
        expect(
            await readFile(join(test.rootDirectory, "demo-applet", "v1", "index.html"), "utf8"),
        ).toBe("from tool");
        expect((await tools[2]!.execute(ctx, { limit: 10 })).applets).toEqual([created.applet]);
        expect((await tools[3]!.execute(ctx, { name: "demo-applet" })).applet).toEqual(
            created.applet,
        );
    });

    it("keeps the current-version runtime schema strict", () => {
        expect(Value.Check(appletCurrentResultSchema, undefined)).toBe(true);
        expect(Value.Check(appletCurrentResultSchema, null)).toBe(false);
    });
});
