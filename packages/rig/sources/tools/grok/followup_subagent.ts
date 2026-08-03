/* Grok Build tool contract, modified for Rig. Copyright 2023-2026 SpaceXAI; Apache-2.0. */
import { Type } from "@sinclair/typebox";

import { applySubagentReadOnlyOverride } from "../../agent/context/applySubagentReadOnlyOverride.js";
import { defineTool } from "../../agent/types.js";
import { requireSubagentContext } from "../../agent/tools/codex/impl/requireSubagentContext.js";

export const grokFollowupSubagentTool = defineTool({
    name: "followup_subagent",
    label: "followup_subagent",
    description:
        "Send follow-up work to a retained subagent and trigger another turn with its full context preserved.",
    arguments: Type.Object({
        target: Type.String({
            description: "Target subagent's Agent ID (preferred) or canonical task path.",
        }),
        prompt: Type.String({ description: "The follow-up instructions." }),
        effort: Type.Optional(
            Type.String({
                description:
                    "New effort level for the subagent. Must be one of its model's allowed effort levels shown in the system prompt.",
            }),
        ),
        read_only: Type.Optional(
            Type.Boolean({
                description:
                    "True switches the child to Read only; false restores the sender's current permission mode. Omit to keep its current mode.",
            }),
        ),
    }),
    returnType: Type.Object({
        agent_id: Type.String(),
        path: Type.String(),
        status: Type.String(),
    }),
    shouldReviewInAutoMode: () => false,
    execute: async ({ effort, prompt, read_only, target }, context) => {
        const subagents = requireSubagentContext(context);
        await applySubagentReadOnlyOverride(subagents, target, read_only);
        const subagent = subagents.followUp(target, prompt, effort);
        return {
            agent_id: subagent.agentId,
            path: subagent.path,
            status: subagent.status,
        };
    },
    toLLM: (result) => [{ type: "text", text: JSON.stringify(result) }],
    toUI: (result) => `Sent follow-up work to ${result.path}.`,
    locks: [],
});
