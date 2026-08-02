import { executePluginWorkspaceCommand } from "./executePluginWorkspaceCommand.js";
import { PluginWorkspaceOperationError } from "./PluginWorkspaceOperationError.js";
import type { ExecuteWorkspaceCommandResponse } from "./types.js";

const MAX_CONCURRENT_PLUGIN_WORKSPACE_COMMANDS = 8;

export function createPluginWorkspaceCommandExecutor(): (
    workspaceRoot: string,
    command: string,
    timeoutMs: number,
) => Promise<ExecuteWorkspaceCommandResponse> {
    let inFlight = 0;
    return async (workspaceRoot, command, timeoutMs) => {
        if (inFlight >= MAX_CONCURRENT_PLUGIN_WORKSPACE_COMMANDS) {
            throw new PluginWorkspaceOperationError(
                `A plugin can run at most ${String(MAX_CONCURRENT_PLUGIN_WORKSPACE_COMMANDS)} workspace commands at once.`,
            );
        }
        inFlight += 1;
        try {
            return await executePluginWorkspaceCommand(workspaceRoot, command, timeoutMs);
        } finally {
            inFlight -= 1;
        }
    };
}
