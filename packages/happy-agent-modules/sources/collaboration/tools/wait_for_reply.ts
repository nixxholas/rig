import { Type, type Static } from "@sinclair/typebox";
import { defineAgentTool } from "@slopus/happy-agent-base";

import type { CollaborationModule } from "../CollaborationModule.js";
import {
    collaborationWaitToolInputSchema,
    collaborationWaitResultSchema,
} from "../CollaborationMessage.js";

/**
 * Providers require an object at the root of a tool's parameters, so the obligation and agent wait
 * variants stay a closed union and travel as one argument.
 */
const waitForReplyToolParametersSchema = Type.Object(
    { input: collaborationWaitToolInputSchema },
    { additionalProperties: false },
);

type WaitForReplyToolParameters = Static<typeof waitForReplyToolParametersSchema>;

/** Wait on a reply obligation or a collaborator run. */
export function waitForReplyTool(collaboration: CollaborationModule, agentId: string) {
    return defineAgentTool({
        name: "wait_for_reply",
        description:
            "Wait until a collaborator answers one of this agent's pending reply obligations, or until a collaborator's run changes state. Agent waits return the bounded current/final output and status.",
        parameters: waitForReplyToolParametersSchema,
        returnType: collaborationWaitResultSchema,
        durable: false,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, { input }: WaitForReplyToolParameters) =>
            await collaboration.waitForReply(ctx, agentId, input),
        toLLM: (result) =>
            "agentId" in result
                ? [
                      {
                          type: "text" as const,
                          text: collaboration.formatAgentObservationForModel(result),
                      },
                  ]
                : [
                      {
                          type: "text" as const,
                          text: `Reply obligation ${result.id} is ${result.status}${
                              result.status !== "answered"
                                  ? ""
                                  : ` (answer ${result.answerMessageId}).`
                          }`,
                      },
                  ],
    });
}
