import { defineAgentTool } from "@slopus/happy-agent-base";

import {
    workspaceSessionTransferToolInputSchema,
    workspaceTransferResultSchema,
    type WorkspaceSessionTransferInput,
} from "../WorkspaceTransfer.js";
import type { WorkspacesModule } from "../WorkspacesModule.js";

/** Ask the host to schedule a session transfer into another workspace. */
export function transferWorkspaceTool(workspaces: WorkspacesModule, agentId: string) {
    return defineAgentTool({
        name: "transfer_workspace",
        description:
            "Transfer this agent or session into an existing workspace. The host owns snapshot, checkout, and filesystem behavior; use the returned state to follow the transfer.",
        parameters: workspaceSessionTransferToolInputSchema,
        returnType: workspaceTransferResultSchema,
        durable: false,
        shouldReviewInAutoMode: () => true,
        describeAutoPermissionAction: ({ targetWorkspaceId }) =>
            `transfer this conversation to workspace ${JSON.stringify(targetWorkspaceId)}, discarding that target's current commit and all local working state`,
        execute: async (ctx, input: WorkspaceSessionTransferInput, call) =>
            await workspaces.transfer(ctx, { ...input, operationId: call.id }),
        toLLM: (result) => [
            {
                type: "text",
                text:
                    result.state === "scheduled"
                        ? `Workspace transfer scheduled for ${result.targetWorkspaceId ?? "the requested workspace"}.`
                        : `Workspace transfer completed for ${
                              result.targetWorkspaceId ?? result.workspace.id
                          }. Path: ${result.workspace.path ?? "(host did not report a path)"}.`,
            },
        ],
    });
}
