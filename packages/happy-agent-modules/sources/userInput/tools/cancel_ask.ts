import { Type, type Static } from "@sinclair/typebox";
import { defineAgentTool } from "@slopus/happy-agent-base";

import type { UserInputModule } from "../UserInputModule.js";
import {
    userInputCancelReasonSchema,
    userInputRequestIdSchema,
    userInputRequestSchema,
} from "../UserInputRequest.js";

const cancelAskToolInputSchema = Type.Union([
    Type.Object(
        {
            requestId: userInputRequestIdSchema,
            reason: Type.Optional(userInputCancelReasonSchema),
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            ask_id: userInputRequestIdSchema,
            reason: Type.Optional(userInputCancelReasonSchema),
        },
        { additionalProperties: false },
    ),
]);

type CancelAskToolInput = Static<typeof cancelAskToolInputSchema>;

/**
 * Withdraw a pending question after the model continues without waiting for its answer.
 * `ask_id` remains accepted as the legacy spelling; new callers should use `requestId`.
 */
export function cancelAskTool(userInput: UserInputModule, agentId: string) {
    return defineAgentTool({
        name: "cancel_ask",
        description:
            "Withdraw a question you asked the user that is still waiting for an answer. Use this when you continued without the user and the answer is no longer needed. The request ID is reported when a question stops waiting.",
        parameters: cancelAskToolInputSchema,
        returnType: userInputRequestSchema,
        durable: false,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, input: CancelAskToolInput) =>
            await userInput.cancel(ctx, agentId, {
                requestId: "requestId" in input ? input.requestId : input.ask_id,
                reason: input.reason ?? "The answer is no longer needed.",
            }),
        toLLM: (request) => [{ type: "text", text: userInput.formatForModel(request) }],
    });
}
