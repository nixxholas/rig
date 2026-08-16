import { lstat, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

import { Value } from "@sinclair/typebox/value";
import { agentDatabaseRows, agentDatabaseRun } from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";
import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import {
    appletCurrentResultSchema,
    appletUpdateInputSchema,
    defaultAppletAllowedScopes,
    appletSchema,
    type AppletImportInput,
} from "../../sources/applets/Applet.js";
import type { AppletEvent } from "../../sources/applets/AppletEvent.js";
import { APPLET_TABLE } from "../../sources/applets/AppletDatabase.js";
import { AppletModule } from "../../sources/applets/AppletModule.js";
import type { AppletSourceReader } from "../../sources/applets/copyAppletTree.js";
import { moduleDatabase, type ModuleDatabase } from "../support/moduleDatabase.js";

let ctx: Context;
const temporaryDirectories: string[] = [];
const databases: ModuleDatabase[] = [];
const PNG_512_RED = createSolidPng(512, 512, [255, 0, 0, 255]);

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
        sourceReaderFactory: async (): Promise<AppletSourceReader> => ({
            lstat: async (path) => {
                const facts = await lstat(path);
                return {
                    isFile: facts.isFile(),
                    isDirectory: facts.isDirectory(),
                    isSymbolicLink: facts.isSymbolicLink(),
                    size: facts.size,
                };
            },
            readdir,
            readFileBuffer: async (path) => await readFile(path),
        }),
        sourcePathPolicy: async (_ctx, requestedPath) => {
            if (requestedPath !== directory && !requestedPath.startsWith(`${directory}/`)) {
                throw new Error("source path is outside the active sharing boundary");
            }
            return requestedPath;
        },
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
            await writeFile(iconPath, PNG_512_RED);
            return iconPath;
        },
    };
}

function createSolidPng(
    width: number,
    height: number,
    [red, green, blue, alpha]: readonly [number, number, number, number],
): Buffer {
    const row = Buffer.alloc(1 + width * 4);
    row[0] = 0;
    for (let x = 0; x < width; x += 1) {
        const offset = 1 + x * 4;
        row[offset] = red;
        row[offset + 1] = green;
        row[offset + 2] = blue;
        row[offset + 3] = alpha;
    }
    const scanlines = Buffer.concat(Array.from({ length: height }, () => row));
    return Buffer.concat([
        Buffer.from("89504e470d0a1a0a", "hex"),
        pngChunk(
            "IHDR",
            (() => {
                const header = Buffer.alloc(13);
                header.writeUInt32BE(width, 0);
                header.writeUInt32BE(height, 4);
                header[8] = 8;
                header[9] = 6;
                return header;
            })(),
        ),
        pngChunk("IDAT", deflateSync(scanlines)),
        pngChunk("IEND", Buffer.alloc(0)),
    ]);
}

function pngChunk(type: string, data: Buffer): Buffer {
    const typeBytes = Buffer.from(type, "ascii");
    const crc = pngCrc32(Buffer.concat([typeBytes, data]));
    const result = Buffer.alloc(12 + data.byteLength);
    result.writeUInt32BE(data.byteLength, 0);
    typeBytes.copy(result, 4);
    data.copy(result, 8);
    result.writeUInt32BE(crc, 8 + data.byteLength);
    return result;
}

function pngCrc32(bytes: Buffer): number {
    let crc = 0xffffffff;
    for (const byte of bytes) {
        let value = (crc ^ byte) & 0xff;
        for (let bit = 0; bit < 8; bit += 1) {
            value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
        }
        crc = ((crc >>> 8) ^ value) >>> 0;
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function importInput(path: string, overrides: Partial<AppletImportInput> = {}): AppletImportInput {
    return {
        name: "demo-applet",
        description: "Demo applet",
        purpose: "test applet",
        authorSessionId: "direct-author",
        path,
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
        expect(created.allowedScopes).toEqual([...defaultAppletAllowedScopes]);
        expect(created.iconThumbhash).toEqual(expect.any(String));
        expect(created.iconThumbhash).toBe("1fsDBwCIiIiHiIiHd4h4d4d4AIqHoHgI");
        expect(Buffer.from(created.iconThumbhash!, "base64")).toHaveLength(24);
        await expect(test.applets.get(ctx, "demo-applet")).resolves.toMatchObject({
            iconThumbhash: created.iconThumbhash,
            iconUrl: created.iconUrl,
        });
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
        expect(await readFile(join(appletDirectory, "favicon.png"))).toEqual(PNG_512_RED);
        const ico = await readFile(join(appletDirectory, "favicon.ico"));
        expect(ico.readUInt16LE(2)).toBe(1);
        expect(ico.subarray(22)).toEqual(PNG_512_RED);
    });

    it("rejects the removed update icon argument and enforces the host path policy", async () => {
        expect(
            Value.Check(appletUpdateInputSchema, {
                path: "/workspace/dist",
                iconPath: "/workspace/icon.png",
                changeDescription: "Change",
            }),
        ).toBe(false);

        const test = await fixture({
            sourcePathPolicy: async () => {
                throw new Error("source path is outside the active sharing boundary");
            },
        });
        const sourcePath = await test.source("source-v1", { "index.html": "blocked" });
        await expect(test.applets.import(ctx, importInput(sourcePath))).rejects.toThrow(
            "outside the active sharing boundary",
        );
        await expect(test.applets.list(ctx)).resolves.toEqual([]);
    });

    it("rejects icons that are not validated 512 by 512 PNGs", async () => {
        const test = await fixture();
        const sourcePath = await test.source("small-icon-source", { "index.html": "small icon" });
        const iconPath = join(test.directory, "small-icon.png");
        await writeFile(iconPath, createSolidPng(1, 1, [255, 0, 0, 255]));

        await expect(
            test.applets.import(ctx, importInput(sourcePath, { iconPath })),
        ).rejects.toThrow("512 by 512");
        await expect(test.applets.list(ctx)).resolves.toEqual([]);
    });

    it("rejects persisted applets with only one icon metadata field", async () => {
        const test = await fixture();
        const sourcePath = await test.source("malformed-icon-source", {
            "index.html": "malformed icon row",
        });
        const created = await test.applets.import(ctx, importInput(sourcePath));
        const malformed = JSON.parse(JSON.stringify(created)) as Record<string, unknown>;
        malformed.iconThumbhash = "only-thumbhash";
        delete malformed.iconUrl;
        await agentDatabaseRun(
            ctx.db,
            sql`UPDATE ${sql.raw(APPLET_TABLE)}
                SET applet_json = ${JSON.stringify(malformed)}
                WHERE name = ${created.name}`,
        );

        await expect(test.applets.get(ctx, created.name)).rejects.toThrow(
            "Applet catalog returned an invalid applet.",
        );
    });

    it("applies the host path policy to icon imports as well as source folders", async () => {
        const requested: string[] = [];
        const test = await fixture({
            sourcePathPolicy: async (_ctx, requestedPath) => {
                requested.push(requestedPath);
                if (requestedPath.endsWith("/icon.png")) {
                    throw new Error("icon path is outside the active sharing boundary");
                }
                return requestedPath;
            },
        });
        const sourcePath = await test.source("source-v1", { "index.html": "blocked icon" });
        const iconPath = await test.icon();

        await expect(
            test.applets.import(ctx, importInput(sourcePath, { iconPath })),
        ).rejects.toThrow("icon path is outside the active sharing boundary");
        expect(requested).toEqual([sourcePath, iconPath]);
        await expect(test.applets.list(ctx)).resolves.toEqual([]);
    });

    it("imports through an injected reader without touching the host source filesystem", async () => {
        const test = await fixture({
            sourcePathPolicy: async () => "/sandbox/build",
            sourceReaderFactory: async () => ({
                lstat: async (path) => {
                    if (path === "/sandbox/build") {
                        return {
                            isFile: false,
                            isDirectory: true,
                            isSymbolicLink: false,
                            size: 0,
                        };
                    }
                    if (path === "/sandbox/build/index.html") {
                        return {
                            isFile: true,
                            isDirectory: false,
                            isSymbolicLink: false,
                            size: 15,
                        };
                    }
                    throw new Error("unknown virtual path");
                },
                readdir: async () => ["index.html"],
                readFileBuffer: async () => Buffer.from("<main>virtual</main>"),
            }),
        });

        await test.applets.import(ctx, importInput("/session/build"));
        await expect(
            readFile(join(test.rootDirectory, "demo-applet", "v1", "index.html"), "utf8"),
        ).resolves.toBe("<main>virtual</main>");
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

    it("rolls the catalog version allocation back when update staging fails", async () => {
        const test = await fixture({ maxSourceFileBytes: 4 });
        const sourceV1 = await test.source("rollback-source-v1", { "index.html": "one" });
        const oversized = await test.source("rollback-source-v2", {
            "index.html": "12345",
        });
        await test.applets.import(ctx, importInput(sourceV1));

        await expect(
            test.applets.update(ctx, "demo-applet", {
                path: oversized,
                changeDescription: "Should roll back",
            }),
        ).rejects.toThrow("per-file byte");
        await expect(test.applets.get(ctx, "demo-applet")).resolves.toMatchObject({
            currentVersion: 1,
            versions: [{ version: 1 }],
        });
        await expect(readdir(join(test.rootDirectory, "demo-applet"))).resolves.toEqual(["v1"]);
    });

    it("renders metadata and every version change description for the model", async () => {
        const test = await fixture();
        const sourceV1 = await test.source("source-v1", { "index.html": "one" });
        const sourceV2 = await test.source("source-v2", { "index.html": "two" });

        await test.applets.import(
            ctx,
            importInput(sourceV1, {
                purpose: "Why it exists",
                sourceDescription: "workspace/build",
                allowedScopes: ["project", "session"],
            }),
        );
        const updated = await test.applets.update(ctx, "demo-applet", {
            path: sourceV2,
            changeDescription: "Adds the second screen",
        });

        const text = test.applets.formatAppletForModel(updated);
        expect(text).toContain("Purpose: Why it exists");
        expect(text).toContain("Author session: direct-author");
        expect(text).toContain("Allowed scopes: project, session");
        expect(text).toContain("Source: workspace/build");
        expect(text).toContain("Initial import");
        expect(text).toContain("Adds the second screen");
    });

    it("keeps every version identity ahead of long change descriptions", async () => {
        const test = await fixture({ maxOutputCharacters: 256 });
        const sourceV1 = await test.source("identity-source-v1", { "index.html": "one" });
        const sourceV2 = await test.source("identity-source-v2", { "index.html": "two" });
        const sourceV3 = await test.source("identity-source-v3", { "index.html": "three" });
        await test.applets.import(ctx, importInput(sourceV1));
        await test.applets.update(ctx, "demo-applet", {
            path: sourceV2,
            changeDescription: "x".repeat(2_000),
        });
        const updated = await test.applets.update(ctx, "demo-applet", {
            path: sourceV3,
            changeDescription: "Third version",
        });

        const text = test.applets.formatAppletForModel(updated);
        expect(text).toContain("Versions: v1, v2, v3");
        expect(text).toContain("Changes:");
    });

    it("enforces the applet scope metadata through its host-facing check", async () => {
        const test = await fixture();
        const sourcePath = await test.source("source-v1", { "index.html": "scoped" });
        await test.applets.import(ctx, importInput(sourcePath, { allowedScopes: ["session"] }));

        await expect(test.applets.assertScopeAllowed(ctx, "demo-applet", "session")).resolves.toBe(
            undefined,
        );
        await expect(
            test.applets.assertScopeAllowed(ctx, "demo-applet", "project"),
        ).rejects.toThrow("not allowed");
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

    it("counts bytes returned by the source reader instead of trusting lstat size", async () => {
        const test = await fixture({
            maxSourceBytes: 1,
            sourceReaderFactory: async () => ({
                lstat: async (path) => {
                    const facts = await lstat(path);
                    return {
                        isFile: facts.isFile(),
                        isDirectory: facts.isDirectory(),
                        isSymbolicLink: facts.isSymbolicLink(),
                        size: facts.isFile() ? 1 : facts.size,
                    };
                },
                readdir,
                readFileBuffer: async (path) => await readFile(path),
            }),
        });
        const sourcePath = await test.source("lying-size-source", {
            "index.html": "more than one byte",
        });

        await expect(test.applets.import(ctx, importInput(sourcePath))).rejects.toThrow(
            "file-count or total-byte",
        );
        await expect(test.applets.list(ctx)).resolves.toEqual([]);
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
        await expect(readdir(test.rootDirectory)).rejects.toMatchObject({ code: "ENOENT" });
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
        await expect(readdir(test.rootDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("does not create import files when an outer transaction rolls back", async () => {
        const test = await fixture();
        const sourcePath = await test.source("source-v1", { "index.html": "rolled back" });

        await expect(
            ctx.inTx(async (txCtx) => {
                await test.applets.import(txCtx, importInput(sourcePath));
                throw new Error("outer import rollback");
            }),
        ).rejects.toThrow("outer import rollback");

        await expect(test.applets.get(ctx, "demo-applet")).resolves.toBeUndefined();
        await expect(readdir(test.rootDirectory)).rejects.toMatchObject({ code: "ENOENT" });
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

    it("allocates overlapping updates from the database transaction", async () => {
        const test = await fixture();
        const sourceV1 = await test.source("source-v1", { "index.html": "one" });
        const sourceV2 = await test.source("source-v2", { "index.html": "two" });
        const sourceV3 = await test.source("source-v3", { "index.html": "three" });
        await test.applets.import(ctx, importInput(sourceV1));

        const results = await ctx.inTx(
            async (txCtx) =>
                await Promise.all([
                    test.applets.update(txCtx, "demo-applet", {
                        path: sourceV2,
                        changeDescription: "Second version",
                    }),
                    test.applets.update(txCtx, "demo-applet", {
                        path: sourceV3,
                        changeDescription: "Third version",
                    }),
                ]),
        );

        expect(results.map((result) => result.currentVersion).sort()).toEqual([2, 3]);
        await expect(test.applets.get(ctx, "demo-applet")).resolves.toMatchObject({
            currentVersion: 3,
            versions: [
                { version: 1 },
                { version: 2, changeDescription: "Second version" },
                { version: 3, changeDescription: "Third version" },
            ],
        });
        await expect(
            readFile(join(test.rootDirectory, "demo-applet", "v2", "index.html"), "utf8"),
        ).resolves.toBe("two");
        await expect(
            readFile(join(test.rootDirectory, "demo-applet", "v3", "index.html"), "utf8"),
        ).resolves.toBe("three");
    });

    it("does not leave an update staging directory when an outer transaction rolls back", async () => {
        const test = await fixture();
        const sourceV1 = await test.source("source-v1", { "index.html": "one" });
        const sourceV2 = await test.source("source-v2", { "index.html": "two" });
        await test.applets.import(ctx, importInput(sourceV1));

        await expect(
            ctx.inTx(async (txCtx) => {
                await test.applets.update(txCtx, "demo-applet", {
                    path: sourceV2,
                    changeDescription: "Rolled-back update",
                });
                throw new Error("outer update rollback");
            }),
        ).rejects.toThrow("outer update rollback");

        await expect(test.applets.get(ctx, "demo-applet")).resolves.toMatchObject({
            currentVersion: 1,
        });
        await expect(readdir(join(test.rootDirectory, "demo-applet"))).resolves.toEqual(["v1"]);
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
        for (const name of [
            "create_applet",
            "import_applet",
            "update_applet",
            "revert_applet",
            "remove_applet",
        ]) {
            const tool = tools.find((candidate) => candidate.name === name)!;
            expect(tool.requiresAutoOrFullAccess).toBe(true);
            expect(await tool.shouldReviewInAutoMode({}, ctx)).toBe(true);
            expect(await tool.shouldRunInFullAccessInAutoMode?.({}, ctx)).toBe(true);
        }
        expect(
            tools
                .find((tool) => tool.name === "remove_applet")!
                .describeAutoPermissionAction?.({ name: "demo-applet" }, ctx),
        ).toContain(join(test.rootDirectory, "demo-applet"));
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
                await revert.execute(txCtx, { name: "demo-applet", version: 1 }, {
                    id: "call-revert",
                    providerCallId: "provider-revert",
                    kv: {},
                    commit: async () => {
                        throw new Error("module must not commit the result");
                    },
                } as never),
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
                await revert.execute(txCtx, { name: "demo-applet", version: 1 }, {
                    id: "call-revert",
                    providerCallId: "provider-revert",
                    kv: {},
                    commit: async (_commitCtx: unknown, value: unknown) => value,
                } as never);
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
