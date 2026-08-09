import { Type } from "@sinclair/typebox";

import { applySubagentReadOnlyOverride } from "../../../context/applySubagentReadOnlyOverride.js";
import { defineTool } from "../../../types.js";
import { managedSubagentSchema, toCodexManagedSubagentResult } from "../impl/subagentSchemas.js";
import { requireSubagentContext } from "../impl/requireSubagentContext.js";

export const codexFollowupTaskTool = defineTool({
    name: "followup_task",
    label: "followup_task",
    namespace: {
        name: "collaboration",
        description: "Tools for spawning and managing sub-agents.",
    },
    description: `Allowed targets: compatible GPT agents using the current Codex provider.
Prefer this native tool for compatible GPT agents because it preserves Codex's encrypted collaboration transport. Use \`collaboration_ext.followup_task\` for non-GPT or cross-provider agents.

Send follow-up work to an existing subagent, including one that completed or was stopped earlier. Its saved session and full context are reused. If it is idle, this starts another turn; if it is busy, the work is queued.`,
    arguments: Type.Object(
        {
            target: Type.String({
                description: "Stable Agent ID (preferred) or canonical task path.",
            }),
            message: Type.String({
                description: "Message text to send to the target agent.",
                encrypted: true,
            }),
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
        const { message, read_only, target } = args;
        const subagents = requireSubagentContext(context);
        await applySubagentReadOnlyOverride(subagents, target, read_only);
        const agent =
            subagents.encryptedMessages === true
                ? subagents.followUp(target, "", undefined, message)
                : subagents.followUp(target, message);
        return toCodexManagedSubagentResult(await agent);
    },
    toLLM: (result) => [{ type: "text", text: JSON.stringify(result) }],
    toUI: (result) => `Sent follow-up work to ${result.path}.`,
    locks: [],
});
