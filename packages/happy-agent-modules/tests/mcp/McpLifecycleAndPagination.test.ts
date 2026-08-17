import { sql } from "drizzle-orm";
import { agentDatabaseRows, agentDatabaseRun } from "@slopus/happy-agent-base";
import { createRootContext } from "@steve.kite/stdlib";
import { describe, expect, it, vi } from "vitest";

import {
    McpModule,
    type McpHost,
    type McpServerPage,
    type McpToolPage,
    type McpToolResult,
} from "../../sources/mcp/index.js";
import { moduleDatabase } from "../support/moduleDatabase.js";
import { resolveModuleHooks } from "../support/moduleHooks.js";

const root = createRootContext().named("mcp-lifecycle-pagination-test");

function host(overrides: Partial<McpHost> = {}): McpHost {
    return {
        callTool: async (): Promise<McpToolResult> => ({ content: [] }),
        getPrompt: async () => ({ messages: [] }),
        listPrompts: async () => ({ prompts: [] }),
        listResourceTemplates: async () => ({ resourceTemplates: [] }),
        listResources: async () => ({ resources: [] }),
        listServers: async () => ({ servers: [] }),
        listTools: async () => ({ tools: [] }),
        readResource: async () => ({ contents: [] }),
        ...overrides,
    } as McpHost;
}

function scope(agentId = "agent-a", permissionMode: "auto" | "workspace_write" = "auto") {
    return { agent: { id: agentId, permissionMode } } as never;
}

function tool(name: string) {
    return {
        name,
        description: name,
        inputSchema: { type: "object" },
    };
}

describe("MCP durable server index lifecycle", () => {
    it("replaces stale index rows transactionally with the current bounded host snapshot", async () => {
        const listServers = vi.fn(
            async (_ctx, _agentId, permissionMode, query): Promise<McpServerPage> => ({
                servers:
                    query.cursor === undefined
                        ? [
                              {
                                  name: "docs",
                                  status: "connected",
                                  toolCount: 2,
                                  fingerprint: "a".repeat(64),
                              },
                          ]
                        : [],
                ...(query.cursor === undefined ? { nextCursor: "next" } : {}),
            }),
        );
        const module = new McpModule({ host: host({ listServers }) });
        const database = moduleDatabase(module.migrations, "mcp-index-lifecycle-test");
        await database.ready;
        try {
            await agentDatabaseRun(
                database.database,
                sql`INSERT INTO mcp_module_index
                    (agent_id, name, status, tool_count, updated_at)
                    VALUES (${"agent-a"}, ${"stale"}, ${"failed"}, ${9}, ${1})`,
            );
            const hooks = await resolveModuleHooks(database.context, module);
            await hooks.beforeAgentLoop!(database.context, scope(), {} as never);

            const rows = await agentDatabaseRows<{
                agent_id: string;
                name: string;
                status: string;
                tool_count: number;
                fingerprint: string | null;
                updated_at: number;
            }>(
                database.database,
                sql`SELECT agent_id, name, status, tool_count, fingerprint, updated_at
                    FROM mcp_module_index ORDER BY name`,
            );
            expect(rows).toHaveLength(1);
            expect(rows[0]).toMatchObject({
                agent_id: "agent-a",
                name: "docs",
                status: "connected",
                tool_count: 2,
                fingerprint: "a".repeat(64),
            });
            expect(rows[0]?.updated_at).toBeGreaterThan(0);
            expect(listServers).toHaveBeenCalledWith(database.context, "agent-a", "auto", {
                limit: 50,
            });
            expect(listServers).toHaveBeenCalledWith(database.context, "agent-a", "auto", {
                cursor: "next",
                limit: 50,
            });
        } finally {
            database.close();
        }
    });

    it("does not touch the index when live server discovery fails", async () => {
        const module = new McpModule({
            host: host({
                listServers: async () => {
                    throw new Error("host offline");
                },
            }),
        });
        const database = moduleDatabase(module.migrations, "mcp-index-failure-test");
        await database.ready;
        try {
            await agentDatabaseRun(
                database.database,
                sql`INSERT INTO mcp_module_index
                    (agent_id, name, status, tool_count, updated_at)
                    VALUES (${"agent-a"}, ${"old"}, ${"connected"}, ${1}, ${1})`,
            );
            const hooks = await resolveModuleHooks(database.context, module);
            await expect(
                hooks.beforeAgentLoop!(database.context, scope(), {} as never),
            ).rejects.toThrow("host offline");
            const rows = await agentDatabaseRows<{ name: string }>(
                database.database,
                sql`SELECT name FROM mcp_module_index WHERE agent_id = ${"agent-a"}`,
            );
            expect(rows).toEqual([{ name: "old" }]);
        } finally {
            database.close();
        }
    });
});

describe("MCP bounded pagination", () => {
    it("loads all server pages and detects duplicate identities across page boundaries", async () => {
        const listServers = vi.fn(async (_ctx, _agentId, _mode, query) => {
            if (query.cursor === undefined) {
                return {
                    nextCursor: "page-2",
                    servers: [{ name: "one", status: "connected" as const, toolCount: 0 }],
                };
            }
            return {
                servers: [{ name: "one", status: "connected" as const, toolCount: 0 }],
            };
        });
        const module = new McpModule({ host: host({ listServers }) });
        const hooks = await resolveModuleHooks(root, module);
        await expect(hooks.tools!(root, scope())).rejects.toThrow("duplicate server identities");
        expect(listServers).toHaveBeenCalledTimes(2);
    });

    it("loads tool pages for a connected server and detects duplicate names across pages", async () => {
        const module = new McpModule({
            host: host({
                listServers: async () => ({
                    servers: [{ name: "docs", status: "connected", toolCount: 2 }],
                }),
                listTools: async (_ctx, _agentId, query): Promise<McpToolPage> =>
                    query.cursor === undefined
                        ? { nextCursor: "page-2", tools: [tool("one")] }
                        : { tools: [tool("one")] },
            }),
        });
        const hooks = await resolveModuleHooks(root, module);
        await expect(hooks.tools!(root, scope())).rejects.toThrow("duplicate tool identities");
    });

    it("stops hostile server and tool cursors at the pagination bound", async () => {
        let serverPage = 0;
        const serverList = vi.fn(async () => ({
            nextCursor: String((serverPage += 1)),
            servers: [{ name: "docs", status: "connected" as const, toolCount: 0 }],
        }));
        const serverModule = new McpModule({ host: host({ listServers: serverList }) });
        const serverHooks = await resolveModuleHooks(root, serverModule);
        await expect(serverHooks.tools!(root, scope())).rejects.toThrow(
            "server pagination exceeded its bound",
        );
        expect(serverList).toHaveBeenCalledTimes(100);

        let toolPage = 0;
        const toolList = vi.fn(async () => ({
            nextCursor: String((toolPage += 1)),
            tools: [tool("one")],
        }));
        const toolModule = new McpModule({
            host: host({
                listServers: async () => ({
                    servers: [{ name: "docs", status: "connected", toolCount: 1 }],
                }),
                listTools: toolList,
            }),
        });
        const hooks = await resolveModuleHooks(root, toolModule);
        await expect(hooks.tools!(root, scope())).rejects.toThrow(
            "tool pagination exceeded its bound",
        );
        expect(toolList).toHaveBeenCalledTimes(100);
    });
});
