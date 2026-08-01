import { Type } from "@sinclair/typebox";

import { applySubagentReadOnlyOverride } from "../../context/applySubagentReadOnlyOverride.js";
import { defineTool } from "../../types.js";

export const claudeSendMessageTool = defineTool({
    name: "SendMessage",
    label: "SendMessage",
    description:
        "Send follow-up work to a previously spawned subagent by its task name, path, or agent id. The agent resumes with its full context preserved.",
    arguments: Type.Object({
        to: Type.String({ description: "The target subagent's task name, path, or agent id." }),
        summary: Type.Optional(
            Type.String({
                description: "A short human-readable summary of the follow-up.",
                maxLength: 200,
            }),
        ),
        message: Type.String({ description: "The follow-up instructions." }),
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
        message: Type.String(),
        success: Type.Boolean(),
        target: Type.String(),
    }),
    shouldReviewInAutoMode: () => false,
    execute: async ({ effort, message, read_only, summary, to }, context) => {
        if (context.subagents === undefined) {
            throw new Error("Subagent management is unavailable in this session.");
        }
        await applySubagentReadOnlyOverride(context.subagents, to, read_only);
        const target = context.subagents.followUp(to, message, effort);
        return {
            message:
                summary === undefined
                    ? `Follow-up work was sent to ${target.description}.`
                    : `${summary}: follow-up work was sent to ${target.description}.`,
            success: true,
            target: target.path,
        };
    },
    toLLM: (result) => [{ type: "text", text: JSON.stringify(result) }],
    toUI: (result) => result.message,
    locks: [],
});
