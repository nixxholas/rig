import { Type, type Static } from "@sinclair/typebox";
import { defineAgentTool } from "@slopus/happy-agent-base";

import type { UserInputFeature } from "../UserInputFeature.js";
import {
    userInputDetailPageSchema,
    userInputDetailQuerySchema,
    userInputRequestIdSchema,
    userInputRequestSchema,
    userInputToolInputSchema,
} from "../UserInputRequest.js";
import { withUserInputToolContext } from "../UserInputToolContext.js";

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
 * completed request by its returned ID. Feature-owned mutation identities are allocated inside
 * the call-scoped AgentKV, never exposed to the model.
 */
export function requestUserInputTool(userInput: UserInputFeature, agentId: string) {
    return defineAgentTool({
        name: "request_user_input",
        description:
            "Ask the human a question with the Markdown context they need, then wait for an explicit answer, cancellation, away, or timeout outcome. This request is durable across daemon restarts. To read more detail from a completed request, call this tool with its requestId and an optional cursor.",
        parameters: requestUserInputToolInputSchema,
        returnType: requestUserInputToolResultSchema,
        durable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, input: RequestUserInputToolInput) => {
            if ("requestId" in input) {
                const { requestId, ...query } = input;
                return await userInput.getPage(ctx, agentId, requestId, query);
            }
            const toolCtx = withUserInputToolContext(ctx);
            const requested = await userInput.ask(toolCtx, agentId, input);
            return await userInput.wait(toolCtx, agentId, { requestId: requested.id });
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