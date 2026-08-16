import { defineAgentTool } from "@slopus/happy-agent-base";
import { Type, type Static } from "@sinclair/typebox";

import type { CollaborationModule } from "../CollaborationModule.js";
import {
    collaborationAgentObservationSchema,
    collaborationAgentIdSchema,
    type CollaborationAgentObservation,
} from "../CollaborationAgent.js";

const interruptAgentInputSchema = Type.Object(
    {
        targetAgentId: collaborationAgentIdSchema,
    },
    { additionalProperties: false },
);
type InterruptAgentInput = Static<typeof interruptAgentInputSchema>;

/** Stop a collaborator's current turn while keeping it available for follow-up work. */
export function interruptAgentTool(collaboration: CollaborationModule, actingAgentId: string) {
    return defineAgentTool({
        name: "interrupt_agent",
        description:
            "Interrupt a collaborator's current turn. The collaborator remains available and can receive follow-up work later.",
        parameters: interruptAgentInputSchema,
        returnType: collaborationAgentObservationSchema,
        durable: false,
        shouldReviewInAutoMode: () => true,
        describeAutoPermissionAction: ({ targetAgentId }) =>
            `interrupting collaborator "${targetAgentId}" and stopping its current turn; the collaborator remains available for follow-up work`,
        execute: async (ctx, input: InterruptAgentInput): Promise<CollaborationAgentObservation> =>
            await collaboration.interruptAgent(ctx, actingAgentId, input.targetAgentId),
        toLLM: (observation) => [
            {
                type: "text",
                text: collaboration.formatAgentObservationForModel(observation),
            },
        ],
    });
}

export { interruptAgentInputSchema };
