import { defineAgentTool } from "@slopus/happy-agent-base";

import {
    workspaceCreateToolInputSchema,
    workspaceSchema,
    type WorkspaceCreateToolInput,
} from "../Workspace.js";
import type { WorkspacesModule } from "../WorkspacesModule.js";

/** Create one host-managed workspace and commit its result with the catalog mutation. */
export function createWorkspaceTool(workspaces: WorkspacesModule, agentId: string) {
    return defineAgentTool({
        name: "create_workspace",
        description:
            "Create one persistent workspace for isolated work. The result includes complete project, base, owner, status, and timestamp detail; follow its detail cursor with get_workspace when the model-output budget requires another page. The host owns its worktree, Git, filesystem, and path policy.",
        parameters: workspaceCreateToolInputSchema,
        returnType: workspaceSchema,
        durable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, input: WorkspaceCreateToolInput, call) =>
            await workspaces.create(
                ctx,
                agentId,
                { ...input, operationId: call.id },
                async (txCtx, workspace) => await call.commit(txCtx, workspace),
            ),
        toLLM: (workspace) => [
            {
                type: "text",
                text: workspaces.formatWorkspaceOperationForModel("Workspace created:", workspace),
            },
        ],
    });
}
