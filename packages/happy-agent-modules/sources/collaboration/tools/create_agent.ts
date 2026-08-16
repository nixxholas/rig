import { defineAgentTool } from "@slopus/happy-agent-base";

import type { CollaborationModule } from "../CollaborationModule.js";
import {
    collaborationAgentSchema,
    collaborationCreateToolInputSchema,
    type CollaborationSpawnCapacity,
    type CollaborationCreateToolInput,
} from "../CollaborationAgent.js";

/** Create a durable collaborator and add it to the host-owned roster. */
export function createAgentTool(
    collaboration: CollaborationModule,
    thisAgentId: string,
    options: {
        readonly capacity: CollaborationSpawnCapacity;
    },
) {
    return defineAgentTool({
        name: "create_agent",
        description: collaboration.formatCreateAgentDescription(
            "Create a collaborator with a durable role and roster entry. Use only when collaboration is explicitly requested. The module assigns an identity; do not invent one.",
            options.capacity,
        ),
        parameters: collaborationCreateToolInputSchema,
        returnType: collaborationAgentSchema,
        durable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, input: CollaborationCreateToolInput, call) =>
            await collaboration.createAgent(ctx, thisAgentId, { ...input, id: call.id }),
        toLLM: (agent) => [
            {
                type: "text",
                text: `Created collaborator ${agent.id}${
                    agent.role === undefined ? "" : ` (${agent.role})`
                }.`,
            },
        ],
    });
}
