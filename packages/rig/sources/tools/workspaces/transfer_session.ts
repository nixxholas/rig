import { Type } from "@sinclair/typebox";

import type { AgentContext } from "../../agent/context/AgentContext.js";
import { defineTool } from "../../agent/types.js";

function requireTransfer(context: AgentContext) {
    if (context.workspaces === undefined) {
        throw new Error("Session transfer is only available in a primary workspace session.");
    }
    return context.workspaces;
}

export const transferSessionTool = defineTool({
    name: "transfer_session",
    label: "Transfer session",
    description:
        "Schedule this conversation to move when the current turn ends, carrying its durable context and source Git state into an existing ready workspace with no attached sessions. The target's current commit and all local working state are discarded. The target is reset to the source's current commit, so committed content always arrives. The source working-tree regular-file and symlink overlay is then copied, including Git-ignored files by default; a root .happyignore file uses gitignore syntax to exclude overlay files such as node_modules, caches, or build output. Tracked deletions are always applied, and .context is always transferred even when .happyignore matches it. Unix sockets, FIFOs, running processes, and runtime state do not move. Subagents spawned earlier remain in the previous workspace. The snapshot happens after this turn ends, so further filesystem changes made this turn are included.",
    arguments: Type.Object(
        {
            target_workspace_id: Type.String({
                minLength: 1,
                description: "Existing ready workspace that should receive this session.",
            }),
        },
        { additionalProperties: false },
    ),
    returnType: Type.Object(
        {
            state: Type.Literal("scheduled"),
            targetWorkspaceId: Type.String(),
        },
        { additionalProperties: false },
    ),
    shouldReviewInAutoMode: () => true,
    describeAutoPermissionAction: ({ target_workspace_id }) =>
        `schedule moving this conversation to workspace ${JSON.stringify(target_workspace_id)} when the turn ends, discarding that target workspace's current commit and all local working state before copying this session's commit and permitted working-tree overlay there`,
    execute: ({ target_workspace_id }, context) =>
        requireTransfer(context).transfer(target_workspace_id),
    toLLM: ({ targetWorkspaceId }) => [
        {
            type: "text",
            text: `Session transfer to workspace ${JSON.stringify(targetWorkspaceId)} is scheduled to complete when this turn ends. Continue using the current workspace for the rest of this turn. Any further filesystem changes made this turn will still be included because the transfer snapshot happens after the turn ends.`,
        },
    ],
    toUI: ({ targetWorkspaceId }) =>
        `Scheduled this session to transfer to workspace ${targetWorkspaceId} when the turn ends.`,
    locks: [],
});
