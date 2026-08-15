import { Type } from "@sinclair/typebox";

import { defineTool } from "../../agent/types.js";

export const agentInfoTool = defineTool({
    name: "agent_info",
    label: "agent_info",
    description:
        "Inspect one Rig agent by an exact, already-known agent ID before sending it a message. This cannot list or search for agents. The result identifies the target and provides a usable path when your disks are shared, or explicitly says when they are not. Calling this successfully is required before agent_send can contact that ID.",
    arguments: Type.Object(
        {
            agent_id: Type.String({
                description: "Exact unguessable agent ID previously shared by the user or agent.",
            }),
        },
        { additionalProperties: false },
    ),
    returnType: Type.Union([
        Type.Object(
            {
                agentId: Type.String({ description: "The target agent's unguessable ID." }),
                diskShared: Type.Literal(true),
                folder: Type.String({
                    description: "The target agent's working-folder name.",
                }),
                path: Type.String({
                    description: "A path to the target agent's folder usable by this agent.",
                }),
                title: Type.Optional(Type.String({ description: "The target agent's title." })),
            },
            { additionalProperties: false },
        ),
        Type.Object(
            {
                agentId: Type.String({ description: "The target agent's unguessable ID." }),
                diskShared: Type.Literal(false),
                notice: Type.String(),
                title: Type.Optional(Type.String({ description: "The target agent's title." })),
            },
            { additionalProperties: false },
        ),
    ]),
    shouldReviewInAutoMode: () => false,
    execute({ agent_id }, context) {
        if (context.agentCommunication === undefined) {
            throw new Error("Agent communication is unavailable in this session.");
        }
        const info = context.agentCommunication.info(agent_id);
        if (info.diskShared) return info;
        const { agentId, notice, title } = info;
        return {
            agentId,
            diskShared: false,
            notice,
            ...(title === undefined ? {} : { title }),
        };
    },
    toLLM: (info) => [
        { type: "text", text: JSON.stringify(info) },
        {
            type: "text",
            text: info.diskShared
                ? `You can now send this agent a message with agent_send using agent_id ${JSON.stringify(info.agentId)}. Its disk is shared with yours; its folder is available at ${JSON.stringify(info.path)}.`
                : `You can now send this agent a message with agent_send using agent_id ${JSON.stringify(info.agentId)}. Its disk is not shared with yours, so you cannot access its folder.`,
        },
    ],
    toUI: (info) =>
        info.diskShared
            ? `${info.title ?? info.folder} · shared at ${info.path}`
            : `${info.title ?? "Agent"} · ${info.notice}`,
    locks: [],
});
