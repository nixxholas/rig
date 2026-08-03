import { Type } from "@sinclair/typebox";

import { applySubagentReadOnlyOverride } from "../../../../context/applySubagentReadOnlyOverride.js";
import { defineTool } from "../../../../types.js";
import { managedSubagentSchema, toCodexManagedSubagentResult } from "../../impl/subagentSchemas.js";
import { requireSubagentContext } from "../../impl/requireSubagentContext.js";

export const codexExtendedFollowupTaskTool = defineTool({
    name: "followup_task",
    label: "followup_task",
    namespace: {
        name: "collaboration_ext",
        description: "Tools for spawning sub-agents across providers and model families.",
    },
    description: `Allowed targets: any existing subagent, including agents started with a different provider or model family.
Use this tool for non-GPT or cross-provider agents. Prefer \`collaboration.followup_task\` for compatible GPT agents because the native tool preserves Codex's encrypted collaboration transport.

Send plaintext follow-up work to an existing subagent and trigger another turn when it is idle.`,
    arguments: Type.Object(
        {
            target: Type.String({
                description: "Stable Agent ID (preferred) or canonical task path.",
            }),
            message: Type.String({
                description: "Plain-text follow-up task for the target agent.",
            }),
            reasoning_effort: Type.Optional(
                Type.String({
                    description:
                        "Reasoning effort override for this turn. Omit to keep the agent's current effort.",
                }),
            ),
            read_only: Type.Optional(
                Type.Boolean({
                    description:
                        "True switches the child to Read only; false restores the sender's current permission mode. Omit to keep its current mode.",
                }),
            ),
        },
        { additionalProperties: false },
    ),
    returnType: managedSubagentSchema,
    shouldReviewInAutoMode: () => false,
    execute: async (args, context) => {
        const { message, read_only, reasoning_effort, target } = args;
        const subagents = requireSubagentContext(context);
        await applySubagentReadOnlyOverride(subagents, target, read_only);
        return toCodexManagedSubagentResult(subagents.followUp(target, message, reasoning_effort));
    },
    toLLM: (result) => [{ type: "text", text: JSON.stringify(result) }],
    toUI: (result) => `Sent follow-up work to ${result.path}.`,
    locks: [],
});
