import { Type, type Static } from "@sinclair/typebox";
import { defineAgentTool } from "@slopus/happy-agent-base";

import type { UserInputModule } from "../UserInputModule.js";
import {
    userInputDetailPageSchema,
    userInputDetailQuerySchema,
    userInputRequestIdSchema,
    userInputRequestSchema,
    userInputToolInputSchema,
} from "../UserInputRequest.js";

const userInputToolDetailInputSchema = Type.Object(
    {
        requestId: userInputRequestIdSchema,
        ...userInputDetailQuerySchema.properties,
    },
    { additionalProperties: false },
);

const requestUserInputToolInputSchema = Type.Union([
    userInputToolInputSchema,
    userInputToolDetailInputSchema,
]);

const requestUserInputToolResultSchema = Type.Union([
    userInputRequestSchema,
    userInputDetailPageSchema,
]);

type RequestUserInputToolInput = Static<typeof requestUserInputToolInputSchema>;

/**
 * Ask the human and durably wait for the explicit outcome, or read the bounded details of a
 * completed request by its returned ID. Agent Base's stable call ID is also the request ID.
 */
export function requestUserInputTool(userInput: UserInputModule, agentId: string) {
    return defineAgentTool({
        name: "request_user_input",
        description:
            "Ask the human a question with the Markdown context they need, then wait for an explicit answer, cancellation, away, or timeout outcome. This request is durable across daemon restarts. To read more detail from a completed request, call this tool with its requestId and an optional cursor.",
        parameters: requestUserInputToolInputSchema,
        returnType: requestUserInputToolResultSchema,
        durable: false,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, input: RequestUserInputToolInput, call) => {
            if ("requestId" in input) {
                const { requestId, ...query } = input;
                return await userInput.getPage(ctx, agentId, requestId, query);
            }
            const request = await userInput.ask(ctx, agentId, input, call.id);
            return await userInput.wait(ctx, agentId, request.id);
        },
        toLLM: (request) => [
            {
                type: "text",
                text:
                    "detail" in request
                        ? userInput.formatDetailPageForModel(request)
                        : userInput.formatForModel(request),
            },
        ],
    });
}