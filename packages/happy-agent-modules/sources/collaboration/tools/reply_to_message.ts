import { defineAgentTool } from "@slopus/happy-agent-base";

import type { CollaborationModule } from "../CollaborationModule.js";
import {
    collaborationReplyToolInputSchema,
    collaborationSendResultSchema,
    type CollaborationReplyToolInput,
} from "../CollaborationMessage.js";

/** Answer one directed reply obligation through the durable host transaction boundary. */
export function replyToMessageTool(collaboration: CollaborationModule, actingAgentId: string) {
    return defineAgentTool({
        name: "reply_to_agent_message",
        description:
            "Reply to a collaborator's pending request. Only the requested responder may answer an obligation. Set readOnly true to switch the recipient to Read only, or false to restore the sender's current permission mode.",
        parameters: collaborationReplyToolInputSchema,
        returnType: collaborationSendResultSchema,
        durable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, input: CollaborationReplyToolInput, call) =>
            await collaboration.replyMessage(ctx, actingAgentId, {
                ...input,
                messageId: call.id,
            }),
        toLLM: ({ message }) => [
            {
                type: "text",
                text: `Reply ${message.id} sent to ${message.toAgentId}.`,
            },
        ],
    });
}
