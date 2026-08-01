import type { AnyDefinedTool } from "../agent/types.js";
import { scheduleMessageTool, waitTool, waitUntilTool } from "../scheduling/index.js";
import { pluginTools } from "../tools/plugins/pluginTools.js";
import { getProviderUsageTool } from "../tools/providerUsage/get_provider_usage.js";
import { cancelAskTool } from "../tools/userInput/cancel_ask.js";
import { getAgentTreeUsageTool } from "../tools/get_agent_tree_usage.js";

export function selectCommonToolsForModel(options: {
    isSubagent: boolean;
}): readonly AnyDefinedTool[] {
    return [
        waitTool,
        waitUntilTool,
        ...(options.isSubagent ? [] : [scheduleMessageTool, cancelAskTool]),
        getAgentTreeUsageTool,
        getProviderUsageTool,
        ...pluginTools,
    ] as readonly AnyDefinedTool[];
}
