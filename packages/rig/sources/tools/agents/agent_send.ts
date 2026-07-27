import { Type } from "@sinclair/typebox";

import { defineTool } from "../../agent/types.js";

export const agentSendTool = defineTool({
    name: "agent_send",
    label: "agent_send",
    description:
        "Send a steering message to another Rig agent after successfully calling agent_info for its exact, unguessable agent ID. This tool cannot discover or list agents and rejects targets that were not inspected first. The receiver gets your agent ID and title so it can reply, plus your folder when your disks are shared.",
    arguments: Type.Object(
        {
            agent_id: Type.String({
                description: "Exact unguessable agent ID previously shared by the user or agent.",
            }),
            message: Type.String({
                description: "Steering message to send to the agent.",
                maxLength: 100_000,
            }),
        },
        { additionalProperties: false },
    ),
    returnType: Type.Object({ delivered: Type.Literal(true) }, { additionalProperties: false }),
    shouldReviewInAutoMode: () => false,
    execute({ agent_id, message }, context) {
        if (context.agentCommunication === undefined) {
            throw new Error("Agent communication is unavailable in this session.");
        }
        return context.agentCommunication.send(agent_id, message);
    },
    toLLM: () => [{ type: "text", text: "The steering message was delivered." }],
    toUI: () => "Sent a steering message to another agent.",
    locks: [],
});
