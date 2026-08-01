/** Converts a display name into the stable identifier form used by Happy MCP tools. */
export function normalizeHappyMcpName(name: string): string {
    return name.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/** Returns the exact tool name ordinary agents receive for a plugin contribution. */
export function createHappyMcpToolName(
    pluginName: string,
    serverName: string,
    toolName: string,
): string {
    return `mcp__${normalizeHappyMcpName(`${pluginName} · ${serverName}`)}__${normalizeHappyMcpName(toolName)}`;
}
