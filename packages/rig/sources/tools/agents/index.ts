export { agentInfoTool } from "./agent_info.js";
export { agentMeTool } from "./agent_me.js";
export { agentSendTool } from "./agent_send.js";

import { agentInfoTool } from "./agent_info.js";
import { agentMeTool } from "./agent_me.js";
import { agentSendTool } from "./agent_send.js";

export const agentCommunicationTools = [agentMeTool, agentInfoTool, agentSendTool] as const;
