import { defineAgentTool } from "@slopus/happy-agent-base";

import {
    mcpServerPageQuerySchema,
    mcpServerPageSchema,
    type McpPermissionMode,
    type McpServerPage,
    type McpServerPageQuery,
} from "../Mcp.js";
import type { McpModule } from "../McpModule.js";

export function listMcpServersTool(
    module: McpModule,
    agentId: string,
    permissionMode: McpPermissionMode,
) {
    return defineAgentTool({
        name: "list_mcp_servers",
        description:
            "List configured MCP servers and their current connection status. Results are bounded and cursor-paged.",
        parameters: mcpServerPageQuerySchema,
        returnType: mcpServerPageSchema,
        requiresAutoOrFullAccess: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, query: McpServerPageQuery): Promise<McpServerPage> =>
            await module.listServerPage(ctx, agentId, query, permissionMode),
        toLLM: (page) => [{ type: "text", text: module.formatServerPageForModel(page) }],
    });
}
