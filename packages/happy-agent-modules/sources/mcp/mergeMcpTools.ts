import type { AnyAgentTool } from "@slopus/happy-agent-base";

import { normalizeMcpName } from "./normalizeMcpName.js";
import type { McpServerSummary } from "./Mcp.js";

export interface McpToolContribution {
    readonly servers: readonly McpServerSummary[];
    readonly tools: readonly AnyAgentTool[];
}

/**
 * Merge MCP tools into one ordinary provider-neutral array.  A name collision quarantines the
 * whole contributing server while leaving unrelated servers available, matching Rig's existing
 * behavior.
 */
export function mergeMcpTools(
    existingTools: readonly AnyAgentTool[],
    loaded: McpToolContribution,
): { servers: readonly McpServerSummary[]; tools: readonly AnyAgentTool[] } {
    const existingNames = new Set(existingTools.map((tool) => tool.name));
    const conflictingNames = new Set(
        loaded.tools.filter((tool) => existingNames.has(tool.name)).map((tool) => tool.name),
    );
    if (conflictingNames.size === 0) {
        return { servers: loaded.servers, tools: [...existingTools, ...loaded.tools] };
    }

    const conflictingServers = new Set<string>();
    const servers = loaded.servers.map((server): McpServerSummary => {
        const prefix = `mcp__${normalizeMcpName(server.name)}__`;
        const conflicts = [...conflictingNames].filter((name) => name.startsWith(prefix));
        if (conflicts.length === 0) return server;
        conflictingServers.add(server.name);
        return {
            errorMessage: `Tool name conflict: ${conflicts.join(", ")}`,
            name: server.name,
            status: "failed",
            toolCount: 0,
        };
    });
    const unresolved = [...conflictingNames].filter(
        (name) =>
            !loaded.servers.some((server) =>
                name.startsWith(`mcp__${normalizeMcpName(server.name)}__`),
            ),
    );
    if (unresolved.length > 0) {
        servers.push({
            errorMessage: `Tool name conflict: ${unresolved.join(", ")}`,
            name: "MCP tools",
            status: "failed",
            toolCount: 0,
        });
    }

    const accepted = loaded.tools.filter(
        (tool) =>
            !existingNames.has(tool.name) &&
            ![...conflictingServers].some((serverName) =>
                tool.name.startsWith(`mcp__${normalizeMcpName(serverName)}__`),
            ),
    );
    return { servers, tools: [...existingTools, ...accepted] };
}
