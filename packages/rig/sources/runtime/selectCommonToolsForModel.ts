import type { AnyDefinedTool } from "../agent/types.js";
import { scheduleMessageTool, waitTool, waitUntilTool } from "../scheduling/index.js";
import { getProviderUsageTool } from "../tools/providerUsage/get_provider_usage.js";

export function selectCommonToolsForModel(options: {
    isSubagent: boolean;
}): readonly AnyDefinedTool[] {
    return [
        waitTool,
        waitUntilTool,
        ...(options.isSubagent ? [] : [scheduleMessageTool]),
        getProviderUsageTool,
    ] as readonly AnyDefinedTool[];
}
