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
import { appletCreateTool } from "../tools/applets/applet_create.js";
import { appletListTool } from "../tools/applets/applet_list.js";
import { appletRevertTool } from "../tools/applets/applet_revert.js";
import { appletUpdateTool } from "../tools/applets/applet_update.js";
import { attachTool } from "../tools/attachments/attach.js";
import { folderTools } from "../tools/folders/folderTools.js";
import { createGeminiTools } from "../tools/gemini/createGeminiTools.js";
import { transferSessionTool } from "../tools/workspaces/transfer_session.js";

export function selectCommonToolsForModel(options: {
    /**
     * Turns on Rig's own Gemini tools, including its search.
     *
     * A common tool, not a vendor one: it belongs to Rig rather than to whichever model happens to
     * be selected, and it is configured by holding a Gemini credential rather than by anything
     * about that model. It was previously appended inside the vendor seam, which meant every model
     * family had to be taught about it separately.
     */
    geminiApiKey?: string;
    /** Whether this conversation can reach the folder tree it lives in. */
    hasFolderContext: boolean;
    hasWorkspaceContext: boolean;
    isSubagent: boolean;
    searchTools?: readonly AnyDefinedTool[];
}): readonly AnyDefinedTool[] {
    return [
        ...(options.searchTools ?? []),
        attachTool,
        ...(options.geminiApiKey === undefined ? [] : createGeminiTools(options.geminiApiKey)),
        ...(options.isSubagent || !options.hasWorkspaceContext ? [] : [transferSessionTool]),
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
        appletCreateTool,
        appletUpdateTool,
        appletRevertTool,
        appletListTool,
        ...(options.hasFolderContext ? folderTools : []),
    ] as readonly AnyDefinedTool[];
}
