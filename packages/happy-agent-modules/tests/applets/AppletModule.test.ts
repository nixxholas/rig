import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Value } from "@sinclair/typebox/value";
import { agentDatabaseRows } from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";
import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import {
    appletCurrentResultSchema,
    appletSchema,
    type AppletImportInput,
} from "../../sources/applets/Applet.js";
import type { AppletEvent } from "../../sources/applets/AppletEvent.js";
import { APPLET_TABLE } from "../../sources/applets/AppletDatabase.js";
import { AppletModule } from "../../sources/applets/AppletModule.js";
import { moduleDatabase, type ModuleDatabase } from "../support/moduleDatabase.js";

let ctx: Context;
const temporaryDirectories: string[] = [];
const databases: ModuleDatabase[] = [];
const PNG_1X1 = Buffer.from("89504e470d0a1a0a0000000d494844520000000100000001", "hex");

afterEach(async () => {
    const paths = temporaryDirectories.splice(0);
    await Promise.all(paths.map(async (path) => await rm(path, { force: true, recursive: true })));
    for (const database of databases.splice(0)) database.close();
});

interface AppletFixture {
    readonly directory: string;
    readonly rootDirectory: string;
    readonly database: ModuleDatabase;
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
    let operation = 0;
    let event = 0;
    let now = 100;
    const applets = new AppletModule({
        rootDirectory,
        idFactory: () => `operation-${++operation}`,
        eventIdFactory: () => `event-${++event}`,
        authorFactory: async (_ctx, agentId) => `author-for-${agentId}`,
        clock: () => now++,
        ...overrides,
    });
    const database = moduleDatabase([], "applets-module-test");
    databases.push(database);
    await database.ready;
    for (const [, migrate] of applets.migrations) {
        await migrate(database.context, database.database);
    }
    ctx = database.context;
    return {
        directory,
        rootDirectory,
        database,
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
        await expect(test.applets.list(ctx)).resolves.toEqual([]);
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
        const sourcePath = await test.source(
            "bounded-source",
            files as unknown as Readonly<Record<string, string | Buffer>>,
        );

        await expect(test.applets.import(ctx, importInput(sourcePath))).rejects.toThrow(message);
        await expect(test.applets.list(ctx)).resolves.toEqual([]);
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
        await expect(test.applets.list(ctx)).resolves.toEqual([]);
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
        await expect(test.applets.list(ctx)).resolves.toEqual([]);
        expect(await readdir(test.rootDirectory)).toEqual([]);
    });

    it("treats a repeated direct import as a conflict instead of replaying a receipt", async () => {
        const test = await fixture();
        const sourcePath = await test.source("source-v1", { "index.html": "stable" });
        const request = importInput(sourcePath, { operationId: "direct-create" });

        await test.applets.import(ctx, request);
        await expect(test.applets.import(ctx, request)).rejects.toThrow("already exists");
        expect(await readdir(join(test.rootDirectory, "demo-applet"))).toEqual(["v1"]);
    });

    it("keeps the immutable migration and drops the obsolete idempotency tables in 002", async () => {
        const test = await fixture();

        expect(test.applets.migrations.map(([key]) => key)).toEqual([
            "001-applets-catalog",
            "002-remove-applet-idempotency",
        ]);
        const tables = await agentDatabaseRows<{ name: string }>(
            ctx.db,
            sql`SELECT name
                FROM sqlite_master
                WHERE type = 'table' AND name LIKE 'happy_agent_module_applet%'
                ORDER BY name`,
        );
        expect(tables.map(({ name }) => name)).toEqual([APPLET_TABLE]);
    });

    it("keeps direct operations and the eight common tools on the same catalog and filesystem", async () => {
        const test = await fixture();
        const sourcePath = await test.source("source-v1", { "index.html": "from tool" });
        const updatedSourcePath = await test.source("source-v2", { "index.html": "updated" });
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
        const call = (id: string) =>
            ({
                id,
                providerCallId: `provider-${id}`,
                kv: {},
                commit: async (_ctx: unknown, result: unknown) => result,
            }) as never;
        const created = await tools[0]!.execute(
            ctx,
            {
                name: "demo-applet",
                description: "Demo applet",
                purpose: "test applet",
                path: sourcePath,
            },
            call("call-create"),
        );
        expect(created.applet.authorSessionId).toBe("author-for-agent-1");
        expect(created.applet.versions[0]!.operationId).toBe("call-create");
        expect(
            await readFile(join(test.rootDirectory, "demo-applet", "v1", "index.html"), "utf8"),
        ).toBe("from tool");
        expect((await tools[2]!.execute(ctx, { limit: 10 }, call("call-list"))).applets).toEqual([
            created.applet,
        ]);
        expect(
            (await tools[3]!.execute(ctx, { name: "demo-applet" }, call("call-get"))).applet,
        ).toEqual(created.applet);
        const updated = await tools[4]!.execute(
            ctx,
            {
                name: "demo-applet",
                path: updatedSourcePath,
                changeDescription: "Updated through the tool",
            },
            call("call-update"),
        );
        expect(updated.applet.versions[1]!.operationId).toBe("call-update");
        expect(tools.map((tool) => tool.durable)).toEqual([
            false,
            false,
            true,
            true,
            false,
            true,
            false,
            true,
        ]);
        expect(tools.map((tool) => tool.transactional ?? false)).toEqual([
            false,
            false,
            false,
            false,
            false,
            true,
            false,
            false,
        ]);
    });

    it("lets Agent Base own the durable revert transaction and result commit", async () => {
        const test = await fixture();
        const sourceV1 = await test.source("source-v1", { "index.html": "one" });
        const sourceV2 = await test.source("source-v2", { "index.html": "two" });
        await test.applets.import(ctx, importInput(sourceV1));
        await test.applets.update(ctx, "demo-applet", {
            path: sourceV2,
            changeDescription: "Second version",
        });
        const tools = test.applets.tools(ctx, { agent: { id: "agent-1" } } as never);
        const revert = tools.find((tool) => tool.name === "revert_applet")!;
        const result = await ctx.inTx(
            async (txCtx) =>
                await revert.execute(
                    txCtx,
                    { name: "demo-applet", version: 1 },
                    {
                        id: "call-revert",
                        providerCallId: "provider-revert",
                        kv: {},
                        commit: async () => {
                            throw new Error("module must not commit the result");
                        },
                    } as never,
                ),
        );

        expect(revert.durable).toBe(true);
        expect(revert.transactional).toBe(true);
        expect(result.applet.currentVersion).toBe(1);
    });

    it("respects an outer Agent Base transaction rollback", async () => {
        const test = await fixture();
        const sourceV1 = await test.source("source-v1", { "index.html": "one" });
        const sourceV2 = await test.source("source-v2", { "index.html": "two" });
        await test.applets.import(ctx, importInput(sourceV1));
        await test.applets.update(ctx, "demo-applet", {
            path: sourceV2,
            changeDescription: "Second version",
        });
        const revert = test.applets
            .tools(ctx, { agent: { id: "agent-1" } } as never)
            .find((tool) => tool.name === "revert_applet")!;

        await expect(
            ctx.inTx(async (txCtx) => {
                await revert.execute(
                    txCtx,
                    { name: "demo-applet", version: 1 },
                    {
                        id: "call-revert",
                        providerCallId: "provider-revert",
                        kv: {},
                        commit: async (_commitCtx: unknown, value: unknown) => value,
                    } as never,
                );
                throw new Error("outer transaction failed");
            }),
        ).rejects.toThrow("outer transaction failed");
        await expect(test.applets.get(ctx, "demo-applet")).resolves.toMatchObject({
            currentVersion: 2,
        });
    });

    it("keeps the current-version runtime schema strict", () => {
        expect(Value.Check(appletCurrentResultSchema, undefined)).toBe(true);
        expect(Value.Check(appletCurrentResultSchema, null)).toBe(false);
    });
});
