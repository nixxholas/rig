import type { AnyDefinedTool } from "../agent/types.js";
import { scheduleMessageTool, waitTool, waitUntilTool } from "../scheduling/index.js";
import { getProviderUsageTool } from "../tools/providerUsage/get_provider_usage.js";
import { cancelAskTool } from "../tools/userInput/cancel_ask.js";

export function selectCommonToolsForModel(options: {
    isSubagent: boolean;
}): readonly AnyDefinedTool[] {
    return [
        waitTool,
        waitUntilTool,
        ...(options.isSubagent ? [] : [scheduleMessageTool, cancelAskTool]),
        getProviderUsageTool,
    ] as readonly AnyDefinedTool[];
}
