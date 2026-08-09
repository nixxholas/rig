import { Type } from "@sinclair/typebox";

import { applySubagentReadOnlyOverride } from "../../../context/applySubagentReadOnlyOverride.js";
import { defineTool } from "../../../types.js";
import { requireSubagentContext } from "../impl/requireSubagentContext.js";
import { collaborationItemsSchema } from "./collaborationItemsSchema.js";
import { collaborationItemsToText } from "./collaborationItemsToText.js";

export const codexV1SendInputTool = defineTool({
    name: "send_input",
    label: "send_input",
    namespace: {
        name: "multi_agent_v1",
        description: "Tools for spawning and managing sub-agents.",
    },
    description:
        "Send a plaintext message to an existing agent. Set interrupt to redirect it immediately.",
    arguments: Type.Object(
        {
            target: Type.String({
                description: "Stable Agent ID (preferred) or canonical task path.",
            }),
            message: Type.Optional(
                Type.String({
                    description:
                        "Legacy plain-text message to send to the agent. Use either message or items.",
                }),
            ),
            items: Type.Optional(collaborationItemsSchema),
            interrupt: Type.Optional(Type.Boolean()),
            read_only: Type.Optional(
                Type.Boolean({
                    description:
                        "True switches the child to Read only; false restores the sender's current permission mode. Omit to keep its current mode.",
                }),
            ),
        },
        { additionalProperties: false },
    ),
    returnType: Type.Object({
        agent_id: Type.String(),
        path: Type.String(),
        submission_id: Type.String({
            description: "Identifier for the queued input submission.",
        }),
    }),
    shouldReviewInAutoMode: () => false,
    execute: async (args, context, execution) => {
        const message = [args.message, collaborationItemsToText(args.items)]
            .filter((value): value is string => value !== undefined && value.length > 0)
            .join("\n");
        if (message.length === 0) throw new Error("send_input requires message or items.");
        const subagents = requireSubagentContext(context);
        await applySubagentReadOnlyOverride(subagents, args.target, args.read_only);
        const agent = await (async () => {
            if (args.interrupt === true) {
                await subagents.interrupt(args.target);
                return await subagents.followUp(args.target, message);
            }
            const sendMessage = subagents.sendMessage;
            return sendMessage === undefined
                ? await subagents.followUp(args.target, message)
                : sendMessage(args.target, message);
        })();
        return {
            agent_id: agent.agentId,
            path: agent.path,
            submission_id: execution.toolCallId ?? args.target,
        };
    },
    toLLM: (result) => [{ type: "text", text: JSON.stringify(result) }],
    toUI: () => "Sent input to the subagent.",
    locks: [],
});
