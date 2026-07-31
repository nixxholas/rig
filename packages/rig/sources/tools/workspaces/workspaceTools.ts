import { Type } from "@sinclair/typebox";

import { defineTool } from "../../agent/types.js";
import type { AgentContext } from "../../agent/context/AgentContext.js";
import type { WorkspaceContext } from "../../agent/context/WorkspaceContext.js";

function requireWorkspaces(context: AgentContext): WorkspaceContext {
    if (context.workspaces === undefined) {
        throw new Error("Workspace tools are only available in a primary session.");
    }
    return context.workspaces;
}

const workspaceResult = Type.Object({
    id: Type.String(),
    name: Type.String(),
    path: Type.String(),
    status: Type.String(),
});

export const createWorkspaceTool = defineTool({
    name: "create_workspace",
    label: "Create workspace",
    description:
        "Create a managed Git workspace owned by this session. Only this session can later archive it or start a workspace agent inside it.",
    arguments: Type.Object(
        {
            base_ref: Type.String({ description: "Git ref to create the workspace from." }),
            name: Type.String({ description: "Human-readable workspace name." }),
        },
        { additionalProperties: false },
    ),
    returnType: workspaceResult,
    shouldReviewInAutoMode: () => false,
    execute: ({ base_ref, name }, context) =>
        requireWorkspaces(context).create({ baseRef: base_ref, name }),
    toLLM: (result) => [{ type: "text", text: JSON.stringify(result) }],
    toUI: (result) => `Created workspace ${result.name}.`,
    locks: [],
});

export const archiveWorkspaceTool = defineTool({
    name: "archive_workspace",
    label: "Archive workspace",
    description:
        "Archive a managed workspace created by this session. Workspaces created by another session cannot be archived with this tool.",
    arguments: Type.Object(
        { workspace_id: Type.String({ description: "Owned workspace ID." }) },
        { additionalProperties: false },
    ),
    returnType: workspaceResult,
    shouldReviewInAutoMode: () => true,
    describeAutoPermissionAction: ({ workspace_id }) =>
        `archive workspace ${JSON.stringify(workspace_id)} and remove its managed worktree`,
    execute: ({ workspace_id }, context) => requireWorkspaces(context).archive(workspace_id),
    toLLM: (result) => [{ type: "text", text: JSON.stringify(result) }],
    toUI: (result) => `Archived workspace ${result.name}.`,
    locks: [],
});

export const spawnWorkspaceAgentTool = defineTool({
    name: "spawn_workspace_agent",
    label: "Start workspace agent",
    description:
        "Start a managed subagent inside a workspace created by this session. It is hidden from the ordinary session list, appears under this session as a subagent, and reports its result back here.",
    arguments: Type.Object(
        {
            workspace_id: Type.String({ description: "Owned, ready workspace ID." }),
            description: Type.String({ description: "Short human-readable task description." }),
            prompt: Type.String({ description: "Complete task instructions." }),
            background: Type.Optional(
                Type.Boolean({ description: "Run in the background. Defaults to true." }),
            ),
        },
        { additionalProperties: false },
    ),
    returnType: Type.Object({
        output: Type.String(),
        path: Type.String(),
        sessionId: Type.String(),
        status: Type.String(),
        taskName: Type.String(),
    }),
    shouldReviewInAutoMode: () => false,
    execute: ({ background = true, description, prompt, workspace_id }, context, execution) =>
        requireWorkspaces(context).spawn(
            {
                background,
                description,
                prompt,
                workspaceId: workspace_id,
                ...(execution.toolCallId === undefined
                    ? {}
                    : { parentToolCallId: execution.toolCallId }),
            },
            execution.signal,
        ),
    toLLM: (result) => [{ type: "text", text: JSON.stringify(result) }],
    toUI: (result) => `Started workspace agent ${result.taskName}.`,
    locks: [],
});

export const workspaceTools = [
    createWorkspaceTool,
    spawnWorkspaceAgentTool,
    archiveWorkspaceTool,
] as const;
