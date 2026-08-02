import type { AnyDefinedTool } from "../agent/types.js";
import { scheduleMessageTool, waitTool, waitUntilTool } from "../scheduling/index.js";
import { pluginTools } from "../tools/plugins/pluginTools.js";
import { getProviderUsageTool } from "../tools/providerUsage/get_provider_usage.js";
import { cancelAskTool } from "../tools/userInput/cancel_ask.js";
import { getAgentTreeUsageTool } from "../tools/get_agent_tree_usage.js";
import { slotCreateTool } from "../tools/slots/slot_create.js";
import { slotListTool } from "../tools/slots/slot_list.js";
import { slotRemoveTool } from "../tools/slots/slot_remove.js";
import { slotUpdateTool } from "../tools/slots/slot_update.js";
import { webappCreateTool } from "../tools/webapps/webapp_create.js";
import { webappListTool } from "../tools/webapps/webapp_list.js";
import { webappRevertTool } from "../tools/webapps/webapp_revert.js";
import { webappUpdateTool } from "../tools/webapps/webapp_update.js";
import { attachTool } from "../tools/attachments/attach.js";

export function selectCommonToolsForModel(options: {
    isSubagent: boolean;
}): readonly AnyDefinedTool[] {
    return [
        attachTool,
        waitTool,
        waitUntilTool,
        ...(options.isSubagent ? [] : [scheduleMessageTool, cancelAskTool]),
        getAgentTreeUsageTool,
        getProviderUsageTool,
        ...pluginTools,
        slotCreateTool,
        slotUpdateTool,
        slotRemoveTool,
        slotListTool,
        webappCreateTool,
        webappUpdateTool,
        webappRevertTool,
        webappListTool,
    ] as readonly AnyDefinedTool[];
}
