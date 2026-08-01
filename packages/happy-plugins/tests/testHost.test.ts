import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
    createHappyPluginTestHost,
    createHappyMcpToolName,
    defineMcpTool,
    type HappyPluginTestHost,
    Type,
} from "../sources/index.js";

const hosts: HappyPluginTestHost[] = [];

afterEach(async () => {
    await Promise.all(hosts.splice(0).map((host) => host.close()));
});

describe("Happy plugin test host", () => {
    it("exposes the exact stable tool identity used by ordinary agents", () => {
        expect(createHappyMcpToolName("Project Tools", "Catalog", "list projects")).toBe(
            "mcp__Project_Tools___Catalog__list_projects",
        );
    });

    it("seeds Rig data, observes SDK requests, lists MCP tools, and calls one", async () => {
        const observed: string[] = [];
        const host = await createHappyPluginTestHost(
            {
                projects: [
                    { id: "project-1", name: "Rig", path: "/workspace/rig" },
                    { id: "project-2", name: "Plugins", path: "/workspace/plugins" },
                ],
                sessions: [
                    {
                        agentId: "agent-1",
                        archived: false,
                        cwd: "/workspace/rig",
                        id: "session-1",
                        projectId: "project-1",
                        status: "idle",
                    },
                ],
                workspaces: [
                    {
                        id: "workspace-1",
                        name: "Plugin work",
                        path: "/workspace/rig/plugin-work",
                        projectId: "project-1",
                        status: "ready",
                        version: 0,
                    },
                ],
            },
            {
                onRequest: (request) => observed.push(`${request.method} ${request.path}`),
                temporaryDirectory: process.cwd(),
            },
        );
        hosts.push(host);

        const server = await host.client.mcp.startServer({
            name: "Project tools",
            tools: [
                defineMcpTool({
                    description: "List the projects visible to this plugin.",
                    inputSchema: Type.Object({}, { additionalProperties: false }),
                    name: "list_projects",
                    async execute() {
                        const projects = await host.client.projects.list();
                        return {
                            content: [{ text: JSON.stringify(projects), type: "text" }],
                        };
                    },
                }),
            ],
        });

        await host.mcp.waitForTools();
        expect(host.mcp.listTools()).toMatchObject([
            { server: "Project tools", tool: "list_projects" },
        ]);
        await expect(host.mcp.callTool("Project tools", "list_projects")).resolves.toMatchObject({
            content: [{ text: expect.stringContaining('"name":"Rig"'), type: "text" }],
        });
        await expect(
            host.client.workspaces.list({ projectId: "project-1" }),
        ).resolves.toMatchObject([{ id: "workspace-1", name: "Plugin work" }]);
        expect(observed).toContain("GET /projects");
        expect(observed).toContain("GET /workspaces?projectId=project-1");
        expect(host.requests.some((request) => request.path === "/mcp/servers")).toBe(true);

        await server.close();
        expect(host.mcp.listTools()).toEqual([]);
    });

    it("creates writable plugin state and removes its temporary root on close", async () => {
        const host = await createHappyPluginTestHost({}, { temporaryDirectory: process.cwd() });
        hosts.push(host);
        const statePath = join(host.environment.HAPPY_PLUGIN_DIRECTORY, "state.txt");

        await writeFile(statePath, "persisted locally\n");
        await expect(readFile(statePath, "utf8")).resolves.toBe("persisted locally\n");

        await host.close();
        await expect(access(host.rootDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("validates data and resolves plugin failures as MCP error results", async () => {
        await expect(
            createHappyPluginTestHost({
                projects: [{ id: "", name: "Broken", path: "/workspace" }],
            }),
        ).rejects.toThrow();

        const host = await createHappyPluginTestHost({}, { temporaryDirectory: process.cwd() });
        hosts.push(host);
        await host.client.mcp.startServer({
            name: "Validation",
            tools: [
                defineMcpTool({
                    description: "Requires one string.",
                    inputSchema: Type.Object({ value: Type.String() }),
                    name: "echo",
                    execute: ({ value }) => ({
                        content: [{ text: value, type: "text" }],
                    }),
                }),
                defineMcpTool({
                    description: "Returns a representative plugin failure.",
                    inputSchema: Type.Object({}),
                    name: "fail",
                    execute() {
                        throw new Error("Expected plugin failure.");
                    },
                }),
            ],
        });
        await host.mcp.waitForTools();

        await expect(host.mcp.callTool("Validation", "echo", { value: 42 })).resolves.toMatchObject(
            {
                content: [{ text: expect.stringContaining("expected schema"), type: "text" }],
                isError: true,
            },
        );
        await expect(host.mcp.callTool("Validation", "fail")).resolves.toEqual({
            content: [{ text: "Expected plugin failure.", type: "text" }],
            isError: true,
        });
    });

    it.each(["close", "end", "error"] as const)(
        "restores its catalog after an unexpected stream %s and stops recovery on close",
        async (mode) => {
            const host = await createHappyPluginTestHost({}, { temporaryDirectory: process.cwd() });
            hosts.push(host);
            const server = await host.client.mcp.startServer({
                name: `Recovery ${mode}`,
                tools: [
                    defineMcpTool({
                        description: "Proves the recovered stream accepts calls.",
                        inputSchema: Type.Object({}),
                        name: "ping",
                        execute: () => ({
                            content: [{ text: "pong", type: "text" }],
                        }),
                    }),
                ],
            });
            const firstRegistration = server.registrationId;

            host.mcp.disconnectServers(mode);
            await expect.poll(() => server.status, { timeout: 2_000 }).toBe("reconnecting");
            expect(server.failure).toEqual(expect.any(String));
            await host.mcp.waitForTools(1, 2_000);
            await expect.poll(() => server.status, { timeout: 2_000 }).toBe("connected");
            expect(server.registrationId).not.toBe(firstRegistration);
            await expect(host.mcp.callTool(`Recovery ${mode}`, "ping")).resolves.toEqual({
                content: [{ text: "pong", type: "text" }],
            });

            const registrationCount = host.requests.filter(
                (request) => request.method === "POST" && request.path === "/mcp/servers",
            ).length;
            await server.close();
            await new Promise((resolve) => setTimeout(resolve, 100));
            expect(server.status).toBe("closed");
            expect(
                host.requests.filter(
                    (request) => request.method === "POST" && request.path === "/mcp/servers",
                ),
            ).toHaveLength(registrationCount);
        },
    );
});
