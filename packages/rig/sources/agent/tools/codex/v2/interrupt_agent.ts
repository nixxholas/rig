import { Type } from "@sinclair/typebox";

import { findManagedSubagent } from "../../../context/findManagedSubagent.js";
import { defineTool } from "../../../types.js";
import { codexAgentStatusSchema } from "../impl/codexAgentStatusSchema.js";
import { requireSubagentContext } from "../impl/requireSubagentContext.js";
import { toCodexAgentStatus } from "../impl/toCodexAgentStatus.js";

export const codexInterruptAgentTool = defineTool({
    name: "interrupt_agent",
    label: "interrupt_agent",
    namespace: {
        name: "collaboration",
        description: "Tools for spawning and managing sub-agents.",
    },
    description:
        "Stop an existing subagent's current turn. The agent remains available for later follow-up work.",
    arguments: Type.Object({
        target: Type.String({
            description: "Stable Agent ID (preferred) or canonical task path.",
        }),
    }),
    returnType: Type.Object({
        agent_id: Type.String(),
        path: Type.String(),
        previous_status: codexAgentStatusSchema,
    }),
    shouldReviewInAutoMode: () => false,
    execute: ({ target }, context) => {
        const subagents = requireSubagentContext(context);
        const previous = findManagedSubagent(subagents, target);
        subagents.interrupt(target);
        if (previous === undefined) throw new Error(`Subagent '${target}' was not found.`);
        return {
            agent_id: previous.agentId,
            path: previous.path,
            previous_status: toCodexAgentStatus(previous),
        };
    },
    toLLM: (result) => [{ type: "text", text: JSON.stringify(result) }],
    toUI: () => "Interrupted the subagent's current turn.",
    locks: [],
});
