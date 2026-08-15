import { Type } from "@sinclair/typebox";

import { findManagedSubagent } from "../../../context/findManagedSubagent.js";
import { defineTool } from "../../../types.js";
import { codexAgentStatusSchema } from "../impl/codexAgentStatusSchema.js";
import { requireSubagentContext } from "../impl/requireSubagentContext.js";
import { toCodexAgentStatus } from "../impl/toCodexAgentStatus.js";

export const codexV1CloseAgentTool = defineTool({
    name: "close_agent",
    label: "close_agent",
    namespace: {
        name: "multi_agent_v1",
        description: "Tools for spawning and managing sub-agents.",
    },
    description:
        "Close an agent and any open descendants when they are no longer needed, and return the target agent's previous status before shutdown was requested.",
    arguments: Type.Object(
        {
            target: Type.String({
                description: "Stable Agent ID (preferred) or canonical task path.",
            }),
        },
        { additionalProperties: false },
    ),
    returnType: Type.Object({
        agent_id: Type.String(),
        path: Type.String(),
        previous_status: codexAgentStatusSchema,
    }),
    shouldReviewInAutoMode: () => false,
    execute: async ({ target }, context) => {
        const subagents = requireSubagentContext(context);
        const previous = findManagedSubagent(subagents, target);
        if (previous === undefined) throw new Error(`Subagent '${target}' was not found.`);
        await subagents.interrupt(target);
        return {
            agent_id: previous.agentId,
            path: previous.path,
            previous_status: toCodexAgentStatus(previous),
        };
    },
    toLLM: (result) => [{ type: "text", text: JSON.stringify(result) }],
    toUI: () => "Closed the subagent.",
    locks: [],
});
