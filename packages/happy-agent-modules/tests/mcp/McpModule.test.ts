import { createRootContext, type Context } from "@steve.kite/stdlib";
import { describe, expect, it, vi } from "vitest";

import {
    McpModule,
    type McpHost,
    type McpServerPage,
    type McpToolResult,
    createMcpProtocolTools,
    createMcpTrustUserInputRequest,
    fingerprintMcpServer,
    type McpServerConfigEntry,
    handleMcpElicitation,
    mcpResultToContentBlocks,
    isMcpErrorResult,
    humanizeMcpName,
    normalizeMcpName,
} from "../../sources/mcp/index.js";
import { resolveModuleHooks } from "../support/moduleHooks.js";

const ctx = createRootContext().named("mcp-module-test");

function tool(name: string) {
    return {
        name,
        description: `Description for ${name}.`,
        inputSchema: { type: "object", properties: {} },
    };
}

function host(overrides: Partial<McpHost> = {}): McpHost {
    const callTool = vi.fn(
        async (
            _ctx: Context,
            _agentId: string,
            _input: Parameters<McpHost["callTool"]>[2],
            _options: Parameters<McpHost["callTool"]>[3],
        ): Promise<McpToolResult> => ({
            content: [{ type: "text", text: "ok" }],
        }),
    );
    return {
        callTool,
        getPrompt: async () => ({ messages: [] }),
        listPrompts: async () => ({ prompts: [] }),
        listResourceTemplates: async () => ({ resourceTemplates: [] }),
        listResources: async () => ({ resources: [] }),
        listServers: async () => ({
            servers: [
                {
                    name: "deployment_service",
                    status: "connected",
                    toolCount: 1,
                },
            ],
        }),
        listTools: async () => ({ tools: [tool("publish_release")] }),
        readResource: async (_ctx, _agentId, input) => ({
            contents: [{ uri: input.uri, text: "resource text" }],
        }),
        ...overrides,
    } as McpHost;
}

describe("McpModule", () => {
    it("routes configured servers and tools through the injected host", async () => {
        const listServers = vi.fn(async () => ({
            servers: [{ name: "deployment_service", status: "connected" as const, toolCount: 1 }],
        }));
        const module = new McpModule({
            host: host({ listServers }),
        });
        const hooks = await resolveModuleHooks(ctx, module);

        const page = await module.listServerPage(ctx, "agent-a", {}, "auto");
        expect(page.servers[0]?.name).toBe("deployment_service");
        expect(listServers).toHaveBeenCalledWith(ctx, "agent-a", "auto", { limit: 50 });

        const tools = await hooks.tools!(ctx, {
            agent: { id: "agent-a", permissionMode: "auto" },
        } as never);
        expect(tools.map((candidate) => candidate.name)).toContain(
            "mcp__deployment_service__publish_release",
        );
        const direct = tools.find(
            (candidate) => candidate.name === "mcp__deployment_service__publish_release",
        );
        expect(direct?.requiresAutoOrFullAccess).toBe(true);
        expect(await direct?.shouldReviewInAutoMode({}, ctx)).toBe(true);
    });

    it("declares dynamic calls as reviewed regardless of readOnlyHint", async () => {
        const module = new McpModule({ host: host() });
        const hooks = await resolveModuleHooks(ctx, module);
        const tools = await hooks.tools!(ctx, {
            agent: { id: "agent-a", permissionMode: "auto" },
        } as never);
        const call = tools.find((candidate) => candidate.name === "call_mcp_tool");
        expect(call?.requiresAutoOrFullAccess).toBe(true);
        expect(await call?.shouldReviewInAutoMode({} as never, ctx)).toBe(true);
    });

    it("quarantines only a server whose normalized tool names collide", async () => {
        const module = new McpModule({
            host: host({
                listServers: async () => ({
                    servers: [
                        {
                            name: "broken_server",
                            status: "connected" as const,
                            toolCount: 2,
                        },
                        {
                            name: "healthy_server",
                            status: "connected" as const,
                            toolCount: 1,
                        },
                    ],
                }),
                listTools: async (_ctx, _agentId, query) =>
                    query.server === "broken_server"
                        ? {
                              tools: [tool("publish.release"), tool("publish release")],
                          }
                        : { tools: [tool("status")] },
            }),
        });
        const hooks = await resolveModuleHooks(ctx, module);

        const tools = await hooks.tools!(ctx, {
            agent: { id: "agent-a", permissionMode: "auto" },
        } as never);
        const names = tools.map((candidate) => candidate.name);
        expect(names).toContain("mcp__healthy_server__status");
        expect(names).not.toContain("mcp__broken_server__publish_release");

        const listServers = tools.find((candidate) => candidate.name === "list_mcp_servers");
        expect(listServers).toBeDefined();
        const page = (await listServers?.execute(ctx, {}, undefined as never)) as McpServerPage;
        const broken = page?.servers.find((server) => server.name === "broken_server");
        expect(broken).toMatchObject({
            status: "failed",
            toolCount: 0,
        });
        expect(broken?.errorMessage).toContain("collision");
    });

    it("quarantines every server involved in a cross-server normalized collision", async () => {
        const module = new McpModule({
            host: host({
                listServers: async () => ({
                    servers: [
                        {
                            name: "first.server",
                            status: "connected" as const,
                            toolCount: 1,
                        },
                        {
                            name: "first server",
                            status: "connected" as const,
                            toolCount: 1,
                        },
                        {
                            name: "healthy_server",
                            status: "connected" as const,
                            toolCount: 1,
                        },
                    ],
                }),
                listTools: async (_ctx, _agentId, query) =>
                    query.server === "healthy_server"
                        ? { tools: [tool("status")] }
                        : { tools: [tool("run")] },
            }),
        });
        const hooks = await resolveModuleHooks(ctx, module);

        const tools = await hooks.tools!(ctx, {
            agent: { id: "agent-a", permissionMode: "auto" },
        } as never);
        const names = tools.map((candidate) => candidate.name);
        expect(names).toContain("mcp__healthy_server__status");
        expect(names).not.toContain("mcp__first_server__run");

        const listServers = tools.find((candidate) => candidate.name === "list_mcp_servers");
        if (listServers === undefined) throw new Error("MCP server list tool missing.");
        const page = (await listServers.execute(ctx, {}, undefined as never)) as McpServerPage;
        expect(
            page.servers
                .filter((server) => server.name.startsWith("first"))
                .map((server) => server.status),
        ).toEqual(["failed", "failed"]);
    });

    it("enforces enabled and disabled tool policy before host dispatch", async () => {
        const callTool = vi.fn(
            async (): Promise<McpToolResult> => ({ content: [{ type: "text", text: "ok" }] }),
        );
        const module = new McpModule({
            host: host({
                callTool,
                listServers: async () => ({
                    servers: [
                        {
                            name: "deployment_service",
                            status: "connected" as const,
                            toolCount: 3,
                            enabledTools: ["publish_release"],
                            disabledTools: ["delete_release"],
                        },
                    ],
                }),
            }),
        });
        const hooks = await resolveModuleHooks(ctx, module);
        const tools = await hooks.tools!(ctx, {
            agent: { id: "agent-a", permissionMode: "auto" },
        } as never);
        const dynamic = tools.find((candidate) => candidate.name === "call_mcp_tool");
        if (dynamic === undefined) throw new Error("MCP dynamic call tool missing.");
        await expect(
            dynamic.execute(
                ctx,
                {
                    arguments: {},
                    name: "delete_release",
                    server: "deployment_service",
                },
                undefined as never,
            ),
        ).rejects.toThrow('The MCP tool "delete_release" is disabled by the server policy.');
        expect(callTool).not.toHaveBeenCalled();

        await expect(
            module.callTool(ctx, "agent-a", {
                arguments: {},
                name: "delete_release",
                server: "deployment_service",
            }),
        ).rejects.toThrow('The MCP tool "delete_release" is disabled by the server policy.');
        await expect(
            module.callTool(ctx, "agent-a", {
                arguments: {},
                name: "read_release",
                server: "deployment_service",
            }),
        ).rejects.toThrow('The MCP tool "read_release" is disabled by the server policy.');
        expect(callTool).not.toHaveBeenCalled();

        await expect(
            module.callTool(ctx, "agent-a", {
                arguments: {},
                name: "publish_release",
                server: "deployment_service",
            }),
        ).resolves.toEqual({ content: [{ type: "text", text: "ok" }] });
        expect(callTool).toHaveBeenCalledTimes(1);
    });

    it("uses the optional host policy seam when present", async () => {
        const callTool = vi.fn(
            async (): Promise<McpToolResult> => ({ content: [{ type: "text", text: "ok" }] }),
        );
        const getToolPolicy = vi.fn(async () => ({ disabledTools: ["publish_release"] }));
        const module = new McpModule({
            host: host({ callTool, getToolPolicy }),
        });

        await expect(
            module.callTool(ctx, "agent-a", {
                arguments: {},
                name: "publish_release",
                server: "deployment_service",
            }),
        ).rejects.toThrow('The MCP tool "publish_release" is disabled by the server policy.');
        expect(getToolPolicy).toHaveBeenCalledWith(ctx, "agent-a", "deployment_service");
        expect(callTool).not.toHaveBeenCalled();
    });

    it("accepts a bound one-argument elicitation service", () => {
        expect(
            () =>
                new McpModule({
                    host: host(),
                    userInput: {
                        request: async () => ({ status: "cancelled" as const }),
                    },
                }),
        ).not.toThrow();
    });

    it("clamps pages before the host cursor can skip invisible identities", async () => {
        const listTools = vi.fn(async () => ({
            tools: [
                {
                    name: "a".repeat(128),
                    inputSchema: { type: "object", properties: {} },
                },
                {
                    name: "b".repeat(128),
                    inputSchema: { type: "object", properties: {} },
                },
            ],
        }));
        const module = new McpModule({
            host: host({ listTools }),
            maxOutputCharacters: 256,
        });
        await expect(
            module.listToolPage(ctx, "agent-a", { server: "deployment_service" }),
        ).rejects.toThrow("more tools than requested");
        expect(listTools).toHaveBeenCalledWith(
            ctx,
            "agent-a",
            expect.objectContaining({ limit: 1 }),
        );
    });

    it("rejects unknown nested keys from the injected host", async () => {
        const module = new McpModule({
            host: host({
                listTools: async () => ({
                    tools: [{ ...tool("unexpected"), extra: true }],
                }),
            }),
        });
        await expect(
            module.listToolPage(ctx, "agent-a", { server: "deployment_service" }),
        ).rejects.toThrow("invalid tool page");
    });

    it("keeps MCP application errors and bounded output blocks", async () => {
        const result = {
            content: [
                { type: "text" as const, text: "Error: request failed" },
                { type: "text" as const, text: "Retryable: false" },
            ],
            isError: true,
        };
        expect(isMcpErrorResult(result)).toBe(true);
        expect(mcpResultToContentBlocks(result)).toEqual([
            { type: "text", text: "Error: request failed" },
            { type: "text", text: "Retryable: false" },
        ]);
    });

    it("preserves application errors through direct and dynamic tools", async () => {
        const applicationError = {
            content: [
                { type: "text" as const, text: "Error: request failed" },
                { type: "text" as const, text: "Retryable: false" },
            ],
            isError: true,
        };
        const module = new McpModule({
            host: host({
                callTool: async () => applicationError,
            }),
        });
        const hooks = await resolveModuleHooks(ctx, module);
        const tools = await hooks.tools!(ctx, {
            agent: { id: "agent-a", permissionMode: "auto" },
        } as never);
        const direct = tools.find(
            (candidate) => candidate.name === "mcp__deployment_service__publish_release",
        );
        const dynamic = tools.find((candidate) => candidate.name === "call_mcp_tool");
        expect(direct).toBeDefined();
        expect(dynamic).toBeDefined();
        if (direct === undefined || dynamic === undefined) throw new Error("MCP tools missing.");
        const directResult = await direct.execute(ctx, {}, undefined as never);
        const dynamicResult = await dynamic.execute(
            ctx,
            {
                arguments: {},
                name: "publish_release",
                server: "deployment_service",
            },
            undefined as never,
        );
        expect(direct.isError?.(directResult)).toBe(true);
        expect(dynamic.isError?.(dynamicResult)).toBe(true);
        expect(direct.toLLM(directResult)).toEqual([
            { type: "text", text: "Error: request failed" },
            { type: "text", text: "Retryable: false" },
        ]);
        expect(dynamic.toLLM(dynamicResult)).toEqual(direct.toLLM(directResult));
    });

    it("bounds live MCP metadata before exposing it to the model", async () => {
        const module = new McpModule({ host: host(), maxOutputCharacters: 256 });
        const list = createMcpProtocolTools(module, "agent-a", [
            { name: "deployment_service" },
        ]).find((candidate) => candidate.name === "list_mcp_tools");
        expect(list).toBeDefined();
        const blocks = list?.toLLM({
            nextCursor: "next-page",
            tools: Array.from({ length: 100 }, (_, index) => ({
                description: "x".repeat(1_000),
                inputSchema: { type: "object", properties: {} },
                name: `tool_${String(index)}`,
            })),
        } as never);
        const text = blocks?.[0]?.type === "text" ? blocks[0].text : "";
        expect(Buffer.byteLength(text)).toBeLessThanOrEqual(256);
        expect(text).toContain("tool_0");
        expect(text).toContain("More results at cursor next-page.");
    });
});

describe("MCP naming", () => {
    it("keeps the existing normalized and human-readable names", () => {
        expect(normalizeMcpName("openaiDeveloper docs")).toBe("openaiDeveloper_docs");
        expect(humanizeMcpName("openaiDeveloper_docs")).toBe("OpenAI Developer Docs");
    });
});

describe("MCP durable trust records", () => {
    it("fingerprints configuration independently of object key order", () => {
        const left: McpServerConfigEntry = {
            config: {
                args: ["--stdio"],
                command: "docs-server",
                transport: "stdio",
            },
            name: "docs",
            source: "project",
        };
        const right: McpServerConfigEntry = {
            config: {
                command: "docs-server",
                transport: "stdio",
                args: ["--stdio"],
            },
            name: "docs",
            source: "project",
        };
        expect(fingerprintMcpServer(left, "/workspace")).toBe(
            fingerprintMcpServer(right, "/workspace"),
        );
        expect(
            createMcpTrustUserInputRequest({
                ...left,
                effectiveCwd: "/workspace",
                fingerprint: fingerprintMcpServer(left, "/workspace"),
            }).questions[0]?.options[0]?.description,
        ).toContain('Run "docs-server" with arguments "--stdio"');
    });
});

describe("MCP elicitation", () => {
    it("preserves enum values and converts boolean answers", async () => {
        const request = {
            method: "elicitation/create" as const,
            params: {
                message: "Configure deployment.",
                requestedSchema: {
                    type: "object" as const,
                    properties: {
                        environment: {
                            type: "string",
                            enum: ["staging", "production"],
                            enumNames: ["Staging", "Production"],
                        },
                        confirmed: { type: "boolean" },
                    },
                    required: ["environment", "confirmed"],
                },
            },
        };
        const input = {
            request: vi.fn(async (_ctx: Context, value: { requestId: string }) => {
                expect(value.requestId).toMatch(/^mcp:/u);
                return {
                    status: "answered" as const,
                    answers: {
                        environment: ["Production"],
                        confirmed: ["Yes"],
                    },
                };
            }),
        };

        await expect(handleMcpElicitation(ctx, request, input as never)).resolves.toEqual({
            action: "accept",
            content: { environment: "production", confirmed: true },
        });
    });

    it("declines safely when no user-input service is available", async () => {
        const request = {
            method: "elicitation/create" as const,
            params: {
                message: "Continue?",
                requestedSchema: { type: "object" as const, properties: {} },
            },
        };
        await expect(handleMcpElicitation(request, undefined)).resolves.toEqual({
            action: "decline",
        });
    });
});
