import { Type } from "@sinclair/typebox";

import {
    agentTreeUsageSchema,
    type AgentTreeUsage,
} from "../agent/context/AgentTreeUsageContext.js";
import { defineTool } from "../agent/types.js";

export const getAgentTreeUsageTool = defineTool({
    name: "get_agent_tree_usage",
    label: "Get agent tree usage",
    description:
        "Report exact lifetime token usage for the current session and every recursively linked descendant session. The breakdown includes hidden subagents and visible delegated workspace agents, including completed sessions, with stable identities and each session counted once.",
    arguments: Type.Object({}, { additionalProperties: false }),
    returnType: agentTreeUsageSchema,
    execute(_args, context): AgentTreeUsage {
        if (context.agentTreeUsage === undefined) {
            throw new Error("Agent tree usage is unavailable outside a managed Rig session.");
        }
        const result = context.agentTreeUsage.read();
        return {
            sessions: result.sessions.map((session) => ({ ...session })),
            totalTokens: result.totalTokens,
        };
    },
    toLLM: (result) => [{ type: "text", text: JSON.stringify(result) }],
    toUI: (result) =>
        `Read ${result.totalTokens.toLocaleString("en-US")} tokens across ${result.sessions.length} session${result.sessions.length === 1 ? "" : "s"}`,
    shouldReviewInAutoMode: () => false,
    locks: [],
});
