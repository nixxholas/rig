import { Type } from "@sinclair/typebox";

import { defineTool } from "../../agent/types.js";

const agentMeSchema = Type.Object(
    {
        agentId: Type.String({ description: "The current agent's unguessable ID." }),
        title: Type.Optional(Type.String({ description: "The current agent's title." })),
    },
    { additionalProperties: false },
);

export const agentMeTool = defineTool({
    name: "agent_me",
    label: "agent_me",
    description:
        "Get this agent's own unguessable agent ID and title. You may show this information to the human so they can give the ID to another agent and connect the two agents.",
    arguments: Type.Object({}, { additionalProperties: false }),
    returnType: agentMeSchema,
    shouldReviewInAutoMode: () => false,
    execute(_args, context) {
        if (context.agentCommunication === undefined) {
            throw new Error("Agent communication is unavailable in this session.");
        }
        const { agentId, title } = context.agentCommunication.me();
        return {
            agentId,
            ...(title === undefined ? {} : { title }),
        };
    },
    toLLM: (identity) => [
        { type: "text", text: JSON.stringify(identity) },
        {
            type: "text",
            text: "You may forward this agent ID and title to the human so they can share the ID with another agent to connect them.",
        },
    ],
    toUI: (identity) => `${identity.title ?? "Untitled agent"} · agent ${identity.agentId}`,
    locks: [],
});
