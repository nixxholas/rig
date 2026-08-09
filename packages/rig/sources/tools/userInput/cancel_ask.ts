import { Type } from "@sinclair/typebox";

import { defineTool } from "../../agent/types.js";

export const cancelAskTool = defineTool({
    name: "cancel_ask",
    label: "cancel_ask",
    description:
        "Withdraw a question you asked the user that is still waiting for an answer. Use this when the user was away, you continued without them, and the answer is no longer needed. The ask id is reported to you when a question stops waiting.",
    arguments: Type.Object(
        {
            ask_id: Type.String({ description: "The ask id of the question to withdraw." }),
            reason: Type.Optional(
                Type.String({
                    description: "One short sentence telling the user why it no longer matters.",
                }),
            ),
        },
        { additionalProperties: false },
    ),
    returnType: Type.Object(
        {
            cancelled: Type.Boolean(),
            reason: Type.Optional(Type.String()),
        },
        { additionalProperties: false },
    ),
    execution: "immediate",
    steerable: false,
    async execute({ ask_id }, context) {
        if (context.userInput?.cancel === undefined) {
            return {
                cancelled: false,
                reason: "This session cannot withdraw questions.",
            };
        }
        const result = await context.userInput.cancel(ask_id);
        return {
            cancelled: result.cancelled,
            ...(result.reason === undefined ? {} : { reason: result.reason }),
        };
    },
    toLLM: (result) => [
        {
            type: "text",
            text: result.cancelled
                ? "The question was withdrawn and no longer waits for the user."
                : (result.reason ?? "The question could not be withdrawn."),
        },
    ],
    toUI: (result) => (result.cancelled ? "Withdrew a question" : "Could not withdraw a question"),
    shouldReviewInAutoMode: () => false,
    locks: [],
});
