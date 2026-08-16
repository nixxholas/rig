import { Type } from "@sinclair/typebox";
import { defineAgentTool } from "@slopus/happy-agent-base";

import type { CollaborationModule } from "../CollaborationModule.js";
import {
    collaborationSendInputSchema,
    type CollaborationSendInput,
} from "../CollaborationAgent.js";

/** Put one message in a collaborator's inbox. */
export function sendMessageTool(collaboration: CollaborationModule, actingAgentId: string) {
    return defineAgentTool({
        name: "send_agent_message",
        description: [
            "Send a message to a collaborator you created, or back to the agent that created you.",
            "",
            "Messages are one-way. This returns as soon as the message is delivered, and the recipient answers whenever it is ready by sending one back — there is nothing to wait on. To answer a message you received, send one to the agent it came from.",
        ].join("\n"),
        parameters: collaborationSendInputSchema,
        returnType: Type.Void(),
        durable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, input: CollaborationSendInput, call) => {
            await collaboration.sendMessage(ctx, actingAgentId, input, call.id);
        },
        toLLM: () => [
            {
                type: "text",
                text: "Message delivered. Any answer arrives as a message; carry on with other work in the meantime.",
            },
        ],
    });
}
