import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
    createHappyPluginTestHost,
    createHappyMcpToolName,
    defineMcpTool,
    HAPPY_PLUGIN_MAX_STORAGE_KEYS,
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

    it("seeds the plugin catalog for SDK tests", async () => {
        const host = await createHappyPluginTestHost(
            {
                plugins: [
                    {
                        folder: "catalog",
                        isSelf: true,
                        name: "Catalog",
                        state: "running",
                        version: "2.0.0",
                    },
                    {
                        folder: "broken",
                        isSelf: false,
                        name: "Broken",
                        state: "build_failed",
                        version: "0.0.0",
                    },
                ],
            },
            { temporaryDirectory: process.cwd() },
        );
        hosts.push(host);

        await expect(host.client.plugins.list()).resolves.toEqual([
            {
                folder: "catalog",
                isSelf: true,
                name: "Catalog",
                state: "running",
                version: "2.0.0",
            },
            {
                folder: "broken",
                isSelf: false,
                name: "Broken",
                state: "build_failed",
                version: "0.0.0",
            },
        ]);
        expect(host.requests).toContainEqual({ method: "GET", path: "/plugins" });
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
        expect(
            host.requests.filter(
                (request) => request.method === "POST" && request.path.includes("/calls/"),
            ),
        ).toHaveLength(1);
        await expect(
            host.client.workspaces.list({ projectId: "project-1" }),
        ).resolves.toMatchObject([{ id: "workspace-1", name: "Plugin work" }]);
        expect(observed).toContain("GET /projects");
        expect(observed).toContain("GET /workspaces?projectId=project-1");
        expect(host.requests.some((request) => request.path === "/mcp/servers")).toBe(true);

        const registrationId = server.registrationId;
        await server.close();
        await expect.poll(() => host.mcp.listTools()).toEqual([]);
        expect(host.requests).not.toContainEqual({
            method: "DELETE",
            path: `/mcp/servers/${registrationId}`,
        });
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

    it("mirrors provider usage plus app tool and storage access", async () => {
        const host = await createHappyPluginTestHost(
            {
                providerUsage: [
                    {
                        checkedAt: 42,
                        error: null,
                        providerId: "provider-work",
                        usage: {
                            capturedAt: 40,
                            credits: null,
                            exhausted: false,
                            planName: "Team",
                            providerId: "provider-work",
                            vendor: "codex",
                            windows: { fiveHour: null, monthly: null, weekly: null },
                        },
                    },
                ],
            },
            { temporaryDirectory: process.cwd() },
        );
        hosts.push(host);

        await expect(host.client.providers.usage()).resolves.toMatchObject([
            { providerId: "provider-work", usage: { planName: "Team" } },
        ]);
        await host.client.mcp.startServer({
            name: "App backend",
            tools: [
                defineMcpTool({
                    description: "Uppercase a string for the app.",
                    execute: ({ value }) => ({
                        content: [{ text: value.toUpperCase(), type: "text" }],
                    }),
                    inputSchema: Type.Object({ value: Type.String() }),
                    name: "uppercase",
                    visibility: ["app"],
                }),
            ],
        });
        await host.mcp.waitForTools();
        expect(host.mcp.listTools()).toEqual([]);
        await expect(
            host.mcp.callTool("App backend", "uppercase", { value: "blocked" }),
        ).rejects.toThrow("model-visible");
        await expect(
            host.apps.callTool("App backend", "uppercase", { value: "ready" }),
        ).resolves.toMatchObject({ content: [{ text: "READY", type: "text" }] });
        await host.apps.storage.set("view", { mode: "compact" });
        await expect(host.apps.storage.get("view")).resolves.toEqual({ mode: "compact" });
        await expect(host.apps.storage.list()).resolves.toEqual(["view"]);
        await expect(host.apps.storage.set("Bad Key", null)).rejects.toThrow("lowercase");
        await expect(host.apps.storage.set("bigint", 1n)).rejects.toThrow("JSON serializable");
        await expect(host.apps.storage.set("large", "x".repeat(70 * 1024))).rejects.toThrow(
            "cannot exceed 65536",
        );
        for (let index = 1; index < HAPPY_PLUGIN_MAX_STORAGE_KEYS; index += 1) {
            await host.apps.storage.set(`key-${String(index).padStart(4, "0")}`, null);
        }
        await expect(host.apps.storage.set("overflow", null)).rejects.toThrow("too many");
        await host.apps.storage.delete("view");
        await expect(host.apps.storage.get("view")).resolves.toBeUndefined();
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
        expect(
            host.requests.filter(
                (request) => request.method === "POST" && request.path.includes("/calls/"),
            ),
        ).toHaveLength(2);
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
            expect(host.requests).not.toContainEqual({
                method: "DELETE",
                path: `/mcp/servers/${firstRegistration}`,
            });
            await expect(host.mcp.callTool(`Recovery ${mode}`, "ping")).resolves.toEqual({
                content: [{ text: "pong", type: "text" }],
            });

            const activeRegistration = server.registrationId;
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
            expect(host.requests).not.toContainEqual({
                method: "DELETE",
                path: `/mcp/servers/${activeRegistration}`,
            });
        },
    );
});
