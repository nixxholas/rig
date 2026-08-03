import { Type } from "@sinclair/typebox";

import {
    SUBAGENT_EFFORT_ARGUMENT_DESCRIPTION,
    SUBAGENT_MODEL_ARGUMENT_DESCRIPTION,
} from "../../../context/subagentSelectionDescriptions.js";
import { defineTool } from "../../../types.js";
import { humanizeTaskName } from "../impl/humanizeTaskName.js";
import { parseCodexForkTurns } from "./impl/parseCodexForkTurns.js";
import { requireSubagentContext } from "../impl/requireSubagentContext.js";
import { selectCodexForkMessages } from "./impl/selectCodexForkMessages.js";

export const codexSpawnAgentTool = defineTool({
    name: "spawn_agent",
    label: "spawn_agent",
    namespace: {
        name: "collaboration",
        description: "Tools for spawning and managing sub-agents.",
    },
    description: `Allowed provider/model pairs (the current Codex provider is inherited):
- current Codex provider + \`openai/gpt-5.6-sol\`
- current Codex provider + \`openai/gpt-5.6-terra\`
Prefer this native tool for GPT models because it preserves Codex's encrypted collaboration transport.

Spawn a background subagent for a concrete, bounded task. The new agent shares the workspace and reports back when it finishes.`,
    arguments: Type.Object(
        {
            task_name: Type.String({
                description:
                    "Lowercase canonical-path leaf using letters, numbers, and underscores.",
            }),
            message: Type.String({
                description: "Initial plain-text task for the new agent.",
                encrypted: true,
            }),
            fork_turns: Type.Optional(
                Type.String({
                    description:
                        "Optional number of turns to fork. Defaults to `all`. Use `none`, `all`, or a positive integer string such as `3` to fork only the most recent turns.",
                }),
            ),
            model: Type.String({
                description: `${SUBAGENT_MODEL_ARGUMENT_DESCRIPTION} The provider is inferred from recent successful use, the current provider, or the first available match.`,
            }),
            reasoning_effort: Type.String({
                description: SUBAGENT_EFFORT_ARGUMENT_DESCRIPTION,
            }),
            read_only: Type.Optional(
                Type.Boolean({
                    description:
                        "Run this child in Read only. Omit or set false to inherit the parent permission mode.",
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
        const { fork_turns, message, model, read_only, reasoning_effort, task_name } = args;
        const subagents = requireSubagentContext(context);
        const fork = parseCodexForkTurns(fork_turns);
        const parentMessages = execution.messages?.slice(0, -1);
        const result = await subagents.spawn(
            {
                background: true,
                contextMode: fork.contextMode,
                ...(fork.contextMode === "parent" && parentMessages !== undefined
                    ? { contextMessages: selectCodexForkMessages(parentMessages, fork.lastNTurns) }
                    : {}),
                description: humanizeTaskName(task_name),
                ...(subagents.encryptedMessages === true ? { encryptedPrompt: message } : {}),
                effort: reasoning_effort,
                modelId: model,
                ...(read_only === undefined ? {} : { readOnly: read_only }),
                ...(execution.toolCallId === undefined
                    ? {}
                    : { parentToolCallId: execution.toolCallId }),
                prompt: subagents.encryptedMessages === true ? "" : message,
                taskName: task_name,
            },
            execution.signal,
        );
        return {
            agent_id: result.agentId,
            path: result.path,
        };
    },
    toLLM: (result) => [{ type: "text", text: JSON.stringify(result) }],
    toUI: (_result, args) => `Started background task ${humanizeTaskName(args.task_name)}.`,
    locks: [],
});
