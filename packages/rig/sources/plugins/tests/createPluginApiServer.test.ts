import { request as requestHttp } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

import { createHappyPluginClient, defineMcpTool, Type } from "happy-plugins";
import { afterEach, describe, expect, it } from "vitest";

import { InMemorySessionStore } from "../../session/InMemorySessionStore.js";
import { createPluginApiServer } from "../createPluginApiServer.js";
import { PluginMcpRegistry } from "../PluginMcpRegistry.js";

const cleanup: (() => Promise<void> | void)[] = [];

afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((dispose) => dispose()));
});

describe("plugin API server", () => {
    it("requires its plugin token and serves SDK requests over its Unix socket", async () => {
        const directory = await mkdtemp(join(process.cwd(), ".rig-plugin-api-"));
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

    it("forwards SDK-registered MCP calls over the same authenticated socket", async () => {
        const directory = await mkdtemp(join(process.cwd(), ".rig-plugin-api-"));
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
            mcp,
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
            mcp,
            pluginName: "Projects",
            store,
            token: "private-plugin-token",
        });
        await listen(server, socketPath);
        await expect.poll(() => contribution.status, { timeout: 2_000 }).toBe("connected");
        expect(contribution.registrationId).not.toBe(firstRegistrationId);
        expect((await registry.load("/workspace", "auto")).tools).toHaveLength(2);

        await contribution.close();
        expect((await registry.load("/workspace", "auto")).tools).toEqual([]);
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
