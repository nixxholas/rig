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

function requireCrossWorkspace(context: AgentContext): WorkspaceContext {
    const workspaces = requireWorkspaces(context);
    if (!workspaces.crossWorkspace) {
        throw new Error(
            "Working across projects and workspaces is turned off. Ask the user to enable features.cross_workspace in their Rig configuration.",
        );
    }
    return workspaces;
}

const workspaceResult = Type.Object({
    id: Type.String(),
    name: Type.String(),
    path: Type.String(),
    projectId: Type.String(),
    status: Type.String(),
    owned: Type.Optional(Type.Boolean()),
});

export const createWorkspaceTool = defineTool({
    name: "create_workspace",
    label: "Create workspace",
    description:
        "Create a managed Git workspace owned by this session. Only this session can later archive it or start a workspace agent inside it.",
    arguments: Type.Object(
        {
            base_ref: Type.Optional(
                Type.String({
                    description:
                        "Git ref to fork. Omit this to start from the project's main branch on the remote, which is almost always what you want.",
                }),
            ),
            name: Type.String({ description: "Human-readable workspace name." }),
        },
        { additionalProperties: false },
    ),
    returnType: workspaceResult,
    shouldReviewInAutoMode: () => false,
    execute: ({ base_ref, name }, context) =>
        requireWorkspaces(context).create({
            ...(base_ref === undefined ? {} : { baseRef: base_ref }),
            name,
        }),
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

export const listWorkspacesTool = defineTool({
    name: "list_workspaces",
    label: "List workspaces",
    description:
        "List the workspaces of this session's project, or of another project when a project ID is given.",
    arguments: Type.Object(
        {
            project_id: Type.Optional(
                Type.String({
                    description:
                        "Project to list. Defaults to this session's project. Another project requires cross-workspace access.",
                }),
            ),
        },
        { additionalProperties: false },
    ),
    returnType: Type.Object({ workspaces: Type.Array(workspaceResult) }),
    shouldReviewInAutoMode: () => false,
    execute: ({ project_id }, context) => ({
        workspaces: requireWorkspaces(context)
            .listWorkspaces(project_id)
            .map((workspace) => ({ ...workspace })),
    }),
    toLLM: (result) => [{ type: "text", text: JSON.stringify(result) }],
    toUI: (result) =>
        result.workspaces.length === 1
            ? "Found 1 workspace."
            : `Found ${String(result.workspaces.length)} workspaces.`,
    locks: [],
});

export const listWorkspaceSessionsTool = defineTool({
    name: "list_workspace_sessions",
    label: "List sessions",
    description:
        "List the conversations of a project or of one of its workspaces, most recently active first.",
    arguments: Type.Object(
        {
            project_id: Type.Optional(
                Type.String({
                    description:
                        "Project to list. Defaults to this session's project. Another project requires cross-workspace access.",
                }),
            ),
            workspace_id: Type.Optional(
                Type.String({ description: "Restrict the list to one workspace." }),
            ),
        },
        { additionalProperties: false },
    ),
    returnType: Type.Object({
        sessions: Type.Array(
            Type.Object({
                id: Type.String(),
                agentId: Type.String(),
                projectId: Type.String(),
                workspaceId: Type.Optional(Type.String()),
                title: Type.String(),
                status: Type.String(),
                updatedAt: Type.Number(),
                delegatedBy: Type.Optional(Type.String()),
            }),
        ),
    }),
    shouldReviewInAutoMode: () => false,
    execute: ({ project_id, workspace_id }, context) => ({
        sessions: requireWorkspaces(context)
            .listSessions({
                ...(project_id === undefined ? {} : { projectId: project_id }),
                ...(workspace_id === undefined ? {} : { workspaceId: workspace_id }),
            })
            .map((session) => ({ ...session })),
    }),
    toLLM: (result) => [{ type: "text", text: JSON.stringify(result) }],
    toUI: (result) =>
        result.sessions.length === 1
            ? "Found 1 session."
            : `Found ${String(result.sessions.length)} sessions.`,
    locks: [],
});

export const listProjectsTool = defineTool({
    name: "list_projects",
    label: "List projects",
    description: "List every project Rig knows about on this machine.",
    arguments: Type.Object({}, { additionalProperties: false }),
    returnType: Type.Object({
        projects: Type.Array(
            Type.Object({
                id: Type.String(),
                name: Type.String(),
                path: Type.String(),
                current: Type.Boolean(),
            }),
        ),
    }),
    shouldReviewInAutoMode: () => false,
    execute: (_arguments, context) => ({
        projects: requireCrossWorkspace(context)
            .listProjects()
            .map((project) => ({ ...project })),
    }),
    toLLM: (result) => [{ type: "text", text: JSON.stringify(result) }],
    toUI: (result) =>
        result.projects.length === 1
            ? "Found 1 project."
            : `Found ${String(result.projects.length)} projects.`,
    locks: [],
});

export const delegateToWorkspaceTool = defineTool({
    name: "delegate_to_workspace",
    label: "Delegate to workspace",
    description:
        "Start a visible conversation in another workspace and give it a task. The new session appears in the user's session list, keeps this session as its parent, and can be reached afterwards with agent_info and agent_send using the returned agent ID. When the user writes to it themselves, this session is told what they said.",
    arguments: Type.Object(
        {
            workspace_id: Type.String({ description: "Ready workspace to work in." }),
            project_id: Type.Optional(
                Type.String({
                    description:
                        "Project owning the workspace. Defaults to this session's project.",
                }),
            ),
            prompt: Type.String({ description: "Complete task instructions." }),
            title: Type.Optional(
                Type.String({
                    description: "Short human-readable title for the new conversation.",
                }),
            ),
        },
        { additionalProperties: false },
    ),
    returnType: Type.Object({
        agentId: Type.String(),
        projectId: Type.String(),
        sessionId: Type.String(),
        title: Type.String(),
        workspaceId: Type.String(),
        workspacePath: Type.String(),
    }),
    shouldReviewInAutoMode: () => true,
    describeAutoPermissionAction: ({ workspace_id }) =>
        `start a user-visible agent session in workspace ${JSON.stringify(workspace_id)}, which works outside this conversation's own workspace`,
    execute: ({ project_id, prompt, title, workspace_id }, context) =>
        requireWorkspaces(context).delegate({
            prompt,
            workspaceId: workspace_id,
            ...(project_id === undefined ? {} : { projectId: project_id }),
            ...(title === undefined ? {} : { title }),
        }),
    toLLM: (result) => [{ type: "text", text: JSON.stringify(result) }],
    toUI: (result) => `Started ${result.title} in another workspace.`,
    locks: [],
});

export const workspaceTools = [
    createWorkspaceTool,
    spawnWorkspaceAgentTool,
    archiveWorkspaceTool,
    listWorkspacesTool,
    listWorkspaceSessionsTool,
    delegateToWorkspaceTool,
] as const;

export const crossWorkspaceTools = [listProjectsTool] as const;
