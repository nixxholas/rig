import { defineAgentTool } from "@slopus/happy-agent-base";

import type { CollaborationModule } from "../CollaborationModule.js";
import {
    collaborationWaitToolInputSchema,
    collaborationWaitResultSchema,
    type CollaborationWaitToolInput,
} from "../CollaborationMessage.js";

/** Wait on a reply obligation or a collaborator run. */
export function waitForReplyTool(collaboration: CollaborationModule, agentId: string) {
    return defineAgentTool({
        name: "wait_for_reply",
        description:
            "Wait until a collaborator answers one of this agent's pending reply obligations, or until a collaborator's run changes state. Agent waits return the bounded current/final output and status.",
        parameters: collaborationWaitToolInputSchema,
        returnType: collaborationWaitResultSchema,
        durable: false,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, input: CollaborationWaitToolInput) =>
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
