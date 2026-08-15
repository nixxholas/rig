import { Type } from "@sinclair/typebox";

import { findManagedSubagent } from "../../../context/findManagedSubagent.js";
import { defineTool } from "../../../types.js";
import { codexAgentStatusSchema } from "../impl/codexAgentStatusSchema.js";
import { requireSubagentContext } from "../impl/requireSubagentContext.js";
import { toCodexAgentStatus } from "../impl/toCodexAgentStatus.js";

export const codexV1ResumeAgentTool = defineTool({
    name: "resume_agent",
    label: "resume_agent",
    namespace: {
        name: "multi_agent_v1",
        description: "Tools for spawning and managing sub-agents.",
    },
    description:
        "Resume a previously closed agent by stable Agent ID (preferred) or canonical task path so it can receive send_input and wait_agent calls.",
    arguments: Type.Object(
        {
            id: Type.String({
                description: "Stable Agent ID (preferred) or canonical task path.",
            }),
        },
        { additionalProperties: false },
    ),
    returnType: Type.Object({
        agent_id: Type.String(),
        path: Type.String(),
        status: codexAgentStatusSchema,
    }),
    shouldReviewInAutoMode: () => false,
    execute: ({ id }, context) => {
        const subagents = requireSubagentContext(context);
        const agent = findManagedSubagent(subagents, id);
        if (agent === undefined) throw new Error(`Subagent '${id}' was not found.`);
        return {
            agent_id: agent.agentId,
            path: agent.path,
            status: toCodexAgentStatus(agent),
        };
    },
    toLLM: (result) => [{ type: "text", text: JSON.stringify(result) }],
    toUI: () => "Made the subagent available for more work.",
    locks: [],
});
