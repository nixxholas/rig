import { Type } from "@sinclair/typebox";

import { applySubagentReadOnlyOverride } from "../../../context/applySubagentReadOnlyOverride.js";
import { defineTool } from "../../../types.js";
import { managedSubagentSchema, toCodexManagedSubagentResult } from "../impl/subagentSchemas.js";
import { requireSubagentContext } from "../impl/requireSubagentContext.js";

export const codexSendMessageTool = defineTool({
    name: "send_message",
    label: "send_message",
    namespace: {
        name: "collaboration",
        description: "Tools for spawning and managing sub-agents.",
    },
    description:
        "Send a message to an existing agent without waiting for it to finish. A child may message its direct parent, including `/root`; other targets must be subagents in the same retained tree. Target by stable Agent ID (preferred) or canonical task path.",
    arguments: Type.Object(
        {
            target: Type.String({
                description:
                    "Stable Agent ID (preferred) or canonical task path. `/root` is valid for a direct child of the root agent.",
            }),
            message: Type.String({
                description: "Message text to queue on the target agent.",
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
        const sendMessage = subagents.sendMessage;
        if (sendMessage === undefined) throw new Error("Subagent messaging is unavailable.");
        await applySubagentReadOnlyOverride(subagents, target, read_only);
        const agent =
            subagents.encryptedMessages === true
                ? sendMessage(target, "", message)
                : sendMessage(target, message);
        return toCodexManagedSubagentResult(agent);
    },
    toLLM: (result) => [{ type: "text", text: JSON.stringify(result) }],
    toUI: (result) => `Sent a message to ${result.path}.`,
    locks: [],
});
