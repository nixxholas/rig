import { request as requestHttp } from "node:http";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
    createHappyPluginClient,
    defineMcpTool,
    HAPPY_PLUGIN_MAX_COMMAND_OUTPUT_BYTES,
    HAPPY_PLUGIN_MAX_LIST_ITEMS,
    HAPPY_PLUGIN_MAX_MEDIA_BYTES,
    Type,
} from "happy-plugins";
import { afterEach, describe, expect, it, vi } from "vitest";

import { InMemorySessionStore } from "../../session/InMemorySessionStore.js";
import { createGeneratedMediaStore } from "../../generated-media/index.js";
import { createTestSocketDirectory } from "../../testing/createTestSocketDirectory.js";
import { createPluginApiServer } from "../createPluginApiServer.js";
import { MAX_INSTALLED_PLUGINS } from "../discoverPlugins.js";
import { PluginMcpRegistry } from "../PluginMcpRegistry.js";

const cleanup: (() => Promise<void> | void)[] = [];

afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((dispose) => dispose()));
});

describe("plugin API server", () => {
    it("requires its plugin token and serves SDK requests over its Unix socket", async () => {
        const directory = await createTestSocketDirectory();
        cleanup.push(() => rm(directory, { force: true, recursive: true }));
        const socketPath = join(directory, "api.sock");
        const store = new InMemorySessionStore({
            modelCatalog: {
                defaultModelId: "",
                defaultProviderId: "",
                models: [],
                providers: [],
            },
        });
        cleanup.push(() => store.close());
        const server = createPluginApiServer({
            listPlugins: async () => [],
            pluginFolder: "test-plugin",
            pluginName: "Test Plugin",
            store,
            token: "private-plugin-token",
        });
        cleanup.push(
            () =>
                new Promise<void>((resolve) => {
                    server.close(() => resolve());
                    server.closeAllConnections();
                }),
        );
        await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(socketPath, () => {
                server.off("error", reject);
                resolve();
            });
        });

        await expect(
            createHappyPluginClient({
                socketPath,
                token: "private-plugin-token",
            }).projects.list(),
        ).resolves.toEqual([]);
        await expect(unauthorizedStatus(socketPath)).resolves.toBe(401);
    });

    it("creates, lists, updates, and removes slot entries with plugin authorship", async () => {
        const fixture = await createPluginApiFixture();

        await expect(
            fixture.client.slots.create({
                content: { markdown: "Wrong place", type: "text" },
                description: "Invalid shortcut",
                purpose: "Exercise the slot matrix",
                scope: "session",
                sessionId: "missing-session",
                slot: "sidebar",
            }),
        ).rejects.toMatchObject({
            message: "The sidebar slot allows only the everywhere scope.",
            status: 400,
        });

        const created = await fixture.client.slots.create({
            content: { markdown: "Build is green", type: "text" },
            description: "Build status",
            purpose: "Keep the current build visible",
            scope: "everywhere",
            slot: "status-line",
        });
        expect(created).toMatchObject({
            author: { folder: "test-plugin", name: "Test Plugin", type: "plugin" },
            content: { markdown: "Build is green", type: "text" },
            scope: "everywhere",
            slot: "status-line",
        });

        await expect(fixture.client.slots.list({ slot: "status-line" })).resolves.toEqual([created]);
        const updated = await fixture.client.slots.update(created.id, {
            content: {
                action: { message: "show logs", type: "send-current-chat" },
                label: "Open logs",
                type: "button",
            },
            slot: "sidebar",
        });
        expect(updated).toMatchObject({
            author: { folder: "test-plugin", name: "Test Plugin", type: "plugin" },
            slot: "sidebar",
        });
        await expect(fixture.client.slots.remove(created.id)).resolves.toEqual(updated);
        await expect(fixture.client.slots.list()).resolves.toEqual([]);
    });

    it("publishes bounded bytes or plugin-owned files through generated media", async () => {
        const fixture = await createPluginApiFixture();
        await writeFile(join(fixture.pluginDataDirectory, "report.txt"), "path media");
        await writeFile(join(fixture.directory, "outside.txt"), "outside");
        await writeFile(
            join(fixture.pluginDataDirectory, "too-large.bin"),
            Buffer.alloc(HAPPY_PLUGIN_MAX_MEDIA_BYTES + 1),
        );

        const bytesPublished = await fixture.client.media.publish({
            bytes: Buffer.from("byte media"),
            name: "summary.txt",
        });
        expect(bytesPublished).toMatchObject({
            bytes: 10,
            location: expect.stringMatching(/^generated\/summary-[a-f0-9]{8}\.txt$/u),
            name: expect.stringMatching(/^summary-[a-f0-9]{8}\.txt$/u),
        });
        await expect(
            readFile(join(fixture.generatedDirectory, bytesPublished.name), "utf8"),
        ).resolves.toBe("byte media");

        const pathPublished = await fixture.client.media.publish({ path: "report.txt" });
        await expect(
            readFile(join(fixture.generatedDirectory, pathPublished.name), "utf8"),
        ).resolves.toBe("path media");
        await expect(
            fixture.client.media.publish({ path: "../outside.txt" }),
        ).rejects.toMatchObject({
            message: "Plugin media paths cannot leave the plugin data folder.",
            status: 400,
        });
        await expect(
            fixture.client.media.publish({ path: "too-large.bin" }),
        ).rejects.toMatchObject({ status: 413 });
    });

    it("executes one-shot workspace commands with captured output and a bounded timeout", async () => {
        const fixture = await createWorkspaceApiFixture();

        await expect(
            fixture.client.workspaces.exec({
                command: "printf 'captured stdout'; printf 'captured stderr' >&2; pwd",
                workspaceId: fixture.workspaceId,
            }),
        ).resolves.toEqual({
            exitCode: 0,
            stderr: "captured stderr",
            stderrTruncated: false,
            stdout: `captured stdout${fixture.workspacePath}\n`,
            stdoutTruncated: false,
            timedOut: false,
        });

        await expect(
            fixture.client.workspaces.exec({
                command: "sleep 2",
                timeoutMs: 25,
                workspaceId: fixture.workspaceId,
            }),
        ).resolves.toMatchObject({
            exitCode: null,
            stderrTruncated: false,
            stdoutTruncated: false,
            timedOut: true,
        });
    });

    it("reads and writes bounded workspace files while rejecting traversal and symlink escapes", async () => {
        const fixture = await createWorkspaceApiFixture();
        const outside = join(fixture.directory, "outside");
        await mkdir(outside);
        await symlink(outside, join(fixture.workspacePath, "escape"));

        await expect(
            fixture.client.workspaces.files.write({
                content: "plugin file\n",
                path: "nested/report.txt",
                workspaceId: fixture.workspaceId,
            }),
        ).resolves.toEqual({ bytesWritten: 12 });
        await expect(
            fixture.client.workspaces.files.read({
                path: "nested/report.txt",
                workspaceId: fixture.workspaceId,
            }),
        ).resolves.toEqual({ bytes: 12, content: "plugin file\n" });
        await expect(
            fixture.client.workspaces.files.write({
                content: "outside",
                path: "../outside.txt",
                workspaceId: fixture.workspaceId,
            }),
        ).rejects.toMatchObject({ status: 400 });
        await expect(
            fixture.client.workspaces.files.write({
                content: "outside",
                path: "escape/outside.txt",
                workspaceId: fixture.workspaceId,
            }),
        ).rejects.toMatchObject({ status: 400 });
    });

    it("caps each command output stream and reports truncation independently", async () => {
        const fixture = await createWorkspaceApiFixture();
        const script = [
            `process.stdout.write("x".repeat(${String(HAPPY_PLUGIN_MAX_COMMAND_OUTPUT_BYTES + 1)}))`,
            'process.stderr.write("kept stderr")',
        ].join(";");
        const result = await fixture.client.workspaces.exec({
            command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`,
            workspaceId: fixture.workspaceId,
        });

        expect(Buffer.byteLength(result.stdout)).toBe(HAPPY_PLUGIN_MAX_COMMAND_OUTPUT_BYTES);
        expect(result).toMatchObject({
            exitCode: 0,
            stderr: "kept stderr",
            stderrTruncated: false,
            stdoutTruncated: true,
            timedOut: false,
        });
    });

    it("returns sanitized workspace operation failures instead of raw host paths", async () => {
        const fixture = await createWorkspaceApiFixture();
        const missingFile = fixture.client.workspaces.files.read({
            path: "missing.txt",
            workspaceId: fixture.workspaceId,
        });
        await expect(missingFile).rejects.toMatchObject({
            message: "The requested workspace file does not exist.",
            status: 404,
        });
        await expect(missingFile).rejects.not.toThrow(fixture.workspacePath);

        await mkdir(join(fixture.workspacePath, "directory"));
        const directoryWrite = fixture.client.workspaces.files.write({
            content: "not a directory",
            path: "directory",
            workspaceId: fixture.workspaceId,
        });
        await expect(directoryWrite).rejects.toMatchObject({
            message: "The workspace file could not be written because its path is a directory.",
            status: 400,
        });
        await expect(directoryWrite).rejects.not.toThrow(fixture.workspacePath);

        await writeFile(join(fixture.workspacePath, "file-parent"), "file");
        const invalidParentWrite = fixture.client.workspaces.files.write({
            content: "not reachable",
            path: "file-parent/child.txt",
            workspaceId: fixture.workspaceId,
        });
        await expect(invalidParentWrite).rejects.toMatchObject({
            message: "The workspace file path is invalid because part of it is not a directory.",
            status: 400,
        });
        await expect(invalidParentWrite).rejects.not.toThrow(fixture.workspacePath);

        await rm(fixture.workspacePath, { force: true, recursive: true });
        const missingWorkspace = fixture.client.workspaces.exec({
            command: "printf unreachable",
            workspaceId: fixture.workspaceId,
        });
        await expect(missingWorkspace).rejects.toMatchObject({
            message: "The workspace directory is unavailable.",
            status: 404,
        });
        await expect(missingWorkspace).rejects.not.toThrow(fixture.workspacePath);
    });

    it("lists the manager snapshot with plugin states and the caller marked by folder", async () => {
        expect(MAX_INSTALLED_PLUGINS).toBeLessThanOrEqual(HAPPY_PLUGIN_MAX_LIST_ITEMS);
        const longDisplayName = "R".repeat(129);
        const directory = await createTestSocketDirectory();
        cleanup.push(() => rm(directory, { force: true, recursive: true }));
        const socketPath = join(directory, "api.sock");
        const store = new InMemorySessionStore({
            modelCatalog: {
                defaultModelId: "",
                defaultProviderId: "",
                models: [],
                providers: [],
            },
        });
        cleanup.push(() => store.close());
        const server = createPluginApiServer({
            listPlugins: async () => [
                {
                    apps: [],
                    dataDirectory: "/plugin-data/reports",
                    description: "Writes reports.",
                    directory: "/plugins/reports",
                    folder: "reports",
                    logAvailable: true,
                    name: longDisplayName,
                    status: "build_failed",
                    version: "0.0.0",
                },
                {
                    apps: [],
                    dataDirectory: "/plugin-data/archive",
                    description: "Archives work.",
                    directory: "/plugins/archive",
                    folder: "archive",
                    logAvailable: false,
                    name: "Archive",
                    status: "stopped",
                    version: "0.0.0",
                },
                ...Array.from({ length: MAX_INSTALLED_PLUGINS - 2 }, (_, index) => ({
                    apps: [],
                    dataDirectory: `/plugin-data/filler-${String(index)}`,
                    description: "Fills the bounded catalog.",
                    directory: `/plugins/filler-${String(index)}`,
                    folder: `filler-${String(index)}`,
                    logAvailable: false,
                    name: `Filler ${String(index)}`,
                    status: "stopped" as const,
                    version: "0.0.0",
                })),
                {
                    apps: [],
                    dataDirectory: "/plugin-data/clock",
                    description: "Keeps time.",
                    directory: "/plugins/clock",
                    folder: "clock",
                    logAvailable: true,
                    name: "Clock",
                    status: "running",
                    version: "1.2.3",
                },
            ],
            pluginFolder: "clock",
            pluginName: "Clock",
            store,
            token: "private-plugin-token",
        });
        cleanup.push(() => closeServer(server));
        await listen(server, socketPath);

        const plugins = await createHappyPluginClient({
            socketPath,
            token: "private-plugin-token",
        }).plugins.list();
        expect(plugins).toHaveLength(MAX_INSTALLED_PLUGINS);
        expect(plugins.slice(0, 2)).toEqual([
            {
                folder: "reports",
                isSelf: false,
                name: longDisplayName,
                state: "build_failed",
                version: "0.0.0",
            },
            {
                folder: "archive",
                isSelf: false,
                name: "Archive",
                state: "stopped",
                version: "0.0.0",
            },
        ]);
        expect(plugins.at(-1)).toEqual({
            folder: "clock",
            isSelf: true,
            name: "Clock",
            state: "running",
            version: "1.2.3",
        });
    });

    it("forwards SDK-registered MCP calls over the same authenticated socket", async () => {
        const directory = await createTestSocketDirectory();
        cleanup.push(() => rm(directory, { force: true, recursive: true }));
        const socketPath = join(directory, "api.sock");
        const store = new InMemorySessionStore({
            modelCatalog: {
                defaultModelId: "",
                defaultProviderId: "",
                models: [],
                providers: [],
            },
        });
        cleanup.push(() => store.close());
        const registry = new PluginMcpRegistry();
        cleanup.push(() => registry.close());
        const mcp = registry.createConnection({ folder: "projects", name: "Projects" });
        let server = createPluginApiServer({
            listPlugins: async () => [],
            mcp,
            pluginFolder: "projects",
            pluginName: "Projects",
            store,
            token: "private-plugin-token",
        });
        cleanup.push(() => closeServer(server));
        await listen(server, socketPath);
        const client = createHappyPluginClient({
            socketPath,
            token: "private-plugin-token",
        });
        const contribution = await client.mcp.startServer({
            name: "Catalog",
            tools: [
                defineMcpTool({
                    description: "List projects through the plugin SDK.",
                    inputSchema: Type.Object({}),
                    name: "list_projects",
                    async execute() {
                        return {
                            content: [
                                {
                                    text: JSON.stringify(await client.projects.list()),
                                    type: "text",
                                },
                            ],
                        };
                    },
                }),
                defineMcpTool({
                    description: "Return more data than the plugin boundary permits.",
                    inputSchema: Type.Object({}),
                    name: "oversized_result",
                    execute() {
                        return {
                            content: [{ text: "x".repeat(1024 * 1024 + 1), type: "text" }],
                        };
                    },
                }),
            ],
        });
        const firstRegistrationId = contribution.registrationId;

        const tools = (await registry.load("/workspace", "auto")).tools;
        const tool = tools.find((candidate) => candidate.name.endsWith("__list_projects"))!;
        await expect(tool.execute({} as never, {} as never, {})).resolves.toEqual({
            content: [{ text: "[]", type: "text" }],
        });
        const oversized = tools.find((candidate) => candidate.name.endsWith("__oversized_result"))!;
        await expect(oversized.execute({} as never, {} as never, {})).resolves.toMatchObject({
            content: [{ text: expect.stringContaining("request is too large"), type: "text" }],
            isError: true,
        });
        await closeServer(server);
        await rm(socketPath, { force: true });
        await expect.poll(() => contribution.status, { timeout: 2_000 }).toBe("reconnecting");
        expect((await registry.load("/workspace", "auto")).tools).toEqual([]);
        await expect.poll(() => contribution.failure, { timeout: 2_000 }).toContain("ENOENT");

        server = createPluginApiServer({
            listPlugins: async () => [],
            mcp,
            pluginFolder: "projects",
            pluginName: "Projects",
            store,
            token: "private-plugin-token",
        });
        await listen(server, socketPath);
        await expect.poll(() => contribution.status, { timeout: 2_000 }).toBe("connected");
        expect(contribution.registrationId).not.toBe(firstRegistrationId);
        expect((await registry.load("/workspace", "auto")).tools).toHaveLength(2);

        await contribution.close();
        await expect
            .poll(async () => (await registry.load("/workspace", "auto")).tools)
            .toEqual([]);
    });

    it("does not complete an in-flight MCP call after its real socket stream disconnects", async () => {
        const directory = await createTestSocketDirectory();
        cleanup.push(() => rm(directory, { force: true, recursive: true }));
        const socketPath = join(directory, "api.sock");
        const store = new InMemorySessionStore({
            modelCatalog: {
                defaultModelId: "",
                defaultProviderId: "",
                models: [],
                providers: [],
            },
        });
        cleanup.push(() => store.close());
        const registry = new PluginMcpRegistry();
        cleanup.push(() => registry.close());
        const server = createPluginApiServer({
            listPlugins: async () => [],
            mcp: registry.createConnection({ folder: "projects", name: "Projects" }),
            pluginFolder: "projects",
            pluginName: "Projects",
            store,
            token: "private-plugin-token",
        });
        cleanup.push(() => closeServer(server));
        const requests: string[] = [];
        server.on("request", (request) => {
            requests.push(`${request.method ?? "GET"} ${request.url ?? "/"}`);
        });
        await listen(server, socketPath);
        const callStarted = deferred<void>();
        const callAborted = deferred<void>();

        const contribution = await createHappyPluginClient({
            socketPath,
            token: "private-plugin-token",
        }).mcp.startServer({
            name: "Catalog",
            tools: [
                defineMcpTool({
                    description: "List projects.",
                    inputSchema: Type.Object({}),
                    name: "list_projects",
                    execute: (_input, { signal }) =>
                        new Promise((_resolve, reject) => {
                            callStarted.resolve();
                            const abort = () => {
                                callAborted.resolve();
                                reject(new Error("The blocking call was aborted."));
                            };
                            if (signal.aborted) {
                                abort();
                                return;
                            }
                            signal.addEventListener("abort", abort, { once: true });
                        }),
                }),
            ],
        });
        const retiredRegistrationId = contribution.registrationId;
        const tool = (await registry.load("/workspace", "auto")).tools[0]!;
        const call = Promise.resolve(tool.execute({} as never, {} as never, {}));
        const rejectedCall = expect(call).rejects.toThrow("connection closed");
        await callStarted.promise;

        server.closeAllConnections();
        await rejectedCall;
        await callAborted.promise;
        await expect
            .poll(() => contribution.registrationId, { timeout: 2_000 })
            .not.toBe(retiredRegistrationId);
        await expect.poll(() => contribution.status, { timeout: 2_000 }).toBe("connected");
        expect(
            requests.some((request) =>
                request.startsWith(`POST /mcp/servers/${retiredRegistrationId}/calls/`),
            ),
        ).toBe(false);
        expect(requests).not.toContain(`DELETE /mcp/servers/${retiredRegistrationId}`);

        await contribution.close();
    });

    it("does not unregister an MCP registration retired by closing its active stream", async () => {
        const directory = await createTestSocketDirectory();
        cleanup.push(() => rm(directory, { force: true, recursive: true }));
        const socketPath = join(directory, "api.sock");
        const store = new InMemorySessionStore({
            modelCatalog: {
                defaultModelId: "",
                defaultProviderId: "",
                models: [],
                providers: [],
            },
        });
        cleanup.push(() => store.close());
        const registry = new PluginMcpRegistry();
        cleanup.push(() => registry.close());
        const server = createPluginApiServer({
            listPlugins: async () => [],
            mcp: registry.createConnection({ folder: "projects", name: "Projects" }),
            pluginFolder: "projects",
            pluginName: "Projects",
            store,
            token: "private-plugin-token",
        });
        cleanup.push(() => closeServer(server));
        const requests: string[] = [];
        server.on("request", (request) => {
            requests.push(`${request.method ?? "GET"} ${request.url ?? "/"}`);
        });
        await listen(server, socketPath);

        const contribution = await createHappyPluginClient({
            socketPath,
            token: "private-plugin-token",
        }).mcp.startServer({
            name: "Catalog",
            tools: [
                defineMcpTool({
                    description: "List projects.",
                    inputSchema: Type.Object({}),
                    name: "list_projects",
                    execute: () => ({ content: [{ text: "[]", type: "text" }] }),
                }),
            ],
        });
        const retiredRegistrationId = contribution.registrationId;

        await contribution.close();

        expect(contribution.status).toBe("closed");
        await expect
            .poll(async () => (await registry.load("/workspace", "auto")).tools)
            .toEqual([]);
        expect(requests).not.toContain(`DELETE /mcp/servers/${retiredRegistrationId}`);
    });
});

function listen(
    server: ReturnType<typeof createPluginApiServer>,
    socketPath: string,
): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, () => {
            server.off("error", reject);
            resolve();
        });
    });
}

function closeServer(server: ReturnType<typeof createPluginApiServer>): Promise<void> {
    if (!server.listening) {
        server.closeAllConnections();
        return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
    });
}

async function createWorkspaceApiFixture() {
    const directory = await createTestSocketDirectory();
    cleanup.push(() => rm(directory, { force: true, recursive: true }));
    const workspacePath = join(directory, "workspace");
    await mkdir(workspacePath);
    const socketPath = join(directory, "api.sock");
    const store = new InMemorySessionStore({
        modelCatalog: {
            defaultModelId: "",
            defaultProviderId: "",
            models: [],
            providers: [],
        },
    });
    cleanup.push(() => store.close());
    const workspaceId = "workspace-1";
    vi.spyOn(store, "listWorkspaces").mockReturnValue([
        {
            createdAt: 1,
            gitCommonDir: workspacePath,
            id: workspaceId,
            kind: "git_worktree",
            name: "Plugin work",
            orderKey: "a0",
            path: workspacePath,
            presence: "present",
            projectId: "project-1",
            status: "ready",
            storageKey: workspaceId,
            updatedAt: 1,
            version: 0,
        },
    ]);
    const server = createPluginApiServer({
        listPlugins: async () => [],
        pluginFolder: "test-plugin",
        pluginName: "Test Plugin",
        store,
        token: "private-plugin-token",
    });
    cleanup.push(() => closeServer(server));
    await listen(server, socketPath);
    return {
        client: createHappyPluginClient({
            socketPath,
            token: "private-plugin-token",
        }),
        directory,
        workspaceId,
        workspacePath,
    };
}

async function createPluginApiFixture() {
    const directory = await createTestSocketDirectory();
    cleanup.push(() => rm(directory, { force: true, recursive: true }));
    const pluginDataDirectory = join(directory, "plugin-data");
    const generatedDirectory = join(directory, "generated");
    await mkdir(pluginDataDirectory);
    const socketPath = join(directory, "api.sock");
    const store = new InMemorySessionStore({
        modelCatalog: {
            defaultModelId: "",
            defaultProviderId: "",
            models: [],
            providers: [],
        },
    });
    cleanup.push(() => store.close());
    const server = createPluginApiServer({
        generatedMedia: createGeneratedMediaStore({ hostDirectory: generatedDirectory }),
        listPlugins: async () => [],
        pluginDataDirectory,
        pluginFolder: "test-plugin",
        pluginName: "Test Plugin",
        store,
        token: "private-plugin-token",
    });
    cleanup.push(() => closeServer(server));
    await listen(server, socketPath);
    return {
        client: createHappyPluginClient({
            socketPath,
            token: "private-plugin-token",
        }),
        directory,
        generatedDirectory,
        pluginDataDirectory,
    };
}

function unauthorizedStatus(socketPath: string): Promise<number> {
    return new Promise<number>((resolve, reject) => {
        const request = requestHttp(
            { method: "GET", path: "/projects", socketPath },
            (response) => {
                response.resume();
                response.once("end", () => resolve(response.statusCode ?? 500));
            },
        );
        request.once("error", reject);
        request.end();
    });
}

function deferred<T>(): { promise: Promise<T>; resolve: (value?: T) => void } {
    let resolvePromise: (value: T | PromiseLike<T>) => void = () => {};
    const promise = new Promise<T>((resolve) => {
        resolvePromise = resolve;
    });
    return { promise, resolve: (value) => resolvePromise(value as T) };
}
