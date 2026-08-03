import { Type } from "@sinclair/typebox";

import {
    SUBAGENT_EFFORT_ARGUMENT_DESCRIPTION,
    SUBAGENT_MODEL_ARGUMENT_DESCRIPTION,
} from "../../../context/subagentSelectionDescriptions.js";
import { defineTool } from "../../../types.js";
import { requireSubagentContext } from "../impl/requireSubagentContext.js";
import { collaborationItemsSchema } from "./collaborationItemsSchema.js";
import { collaborationItemsToText } from "./collaborationItemsToText.js";

export const codexV1SpawnAgentTool = defineTool({
    name: "spawn_agent",
    label: "spawn_agent",
    namespace: {
        name: "multi_agent_v1",
        description: "Tools for spawning and managing sub-agents.",
    },
    description: "Spawn a subagent using the legacy plaintext Codex collaboration protocol.",
    arguments: Type.Object(
        {
            message: Type.Optional(
                Type.String({
                    description:
                        "Initial plain-text task for the new agent. Use either message or items.",
                }),
            ),
            items: Type.Optional(collaborationItemsSchema),
            agent_type: Type.Optional(
                Type.String({
                    description:
                        "Agent type override for the new agent. Omit to use the default agent.",
                }),
            ),
            fork_context: Type.Optional(
                Type.Boolean({
                    description:
                        "True forks the current thread history into the new agent; false or omitted starts with only the initial prompt.",
                }),
            ),
            model: Type.String({
                description: SUBAGENT_MODEL_ARGUMENT_DESCRIPTION,
            }),
            provider: Type.Optional(
                Type.String({
                    description:
                        "Optional provider ID for the new agent. Omit to let Rig select an available provider for the model.",
                }),
            ),
            reasoning_effort: Type.String({
                description: SUBAGENT_EFFORT_ARGUMENT_DESCRIPTION,
            }),
            read_only: Type.Optional(
                Type.Boolean({
                    description:
                        "Run this child in Read only. Omit or set false to inherit the parent permission mode.",
                }),
            ),
            service_tier: Type.Optional(
                Type.Literal("priority", {
                    description:
                        "Service tier override for the new agent. Omit unless explicitly requested.",
                }),
            ),
        },
        { additionalProperties: false },
    ),
    returnType: Type.Object({
        agent_id: Type.String(),
        path: Type.String(),
    }),
    shouldReviewInAutoMode: () => false,
    execute: async (args, context, execution) => {
        const prompt = [args.message, collaborationItemsToText(args.items)]
            .filter((value): value is string => value !== undefined && value.length > 0)
            .join("\n");
        if (prompt.length === 0) throw new Error("spawn_agent requires message or items.");
        const parentMessages = execution.messages?.slice(0, -1);
        const result = await requireSubagentContext(context).spawn({
            background: true,
            contextMode: args.fork_context === true ? "parent" : "task",
            ...(args.fork_context === true && parentMessages !== undefined
                ? { contextMessages: parentMessages }
                : {}),
            description:
                args.agent_type === undefined || args.agent_type.trim().length === 0
                    ? "Delegated task"
                    : args.agent_type.trim(),
            effort: args.reasoning_effort,
            modelId: args.model,
            ...(args.provider === undefined ? {} : { providerId: args.provider }),
            ...(args.read_only === undefined ? {} : { readOnly: args.read_only }),
            ...(execution.toolCallId === undefined
                ? {}
                : { parentToolCallId: execution.toolCallId }),
            prompt,
            ...(args.service_tier === "priority" ? { serviceTier: "fast" as const } : {}),
        });
        return { agent_id: result.agentId, path: result.path };
    },
    toLLM: (result) => [{ type: "text", text: JSON.stringify(result) }],
    toUI: (result) => `Started background task ${result.path}.`,
    locks: [],
});
