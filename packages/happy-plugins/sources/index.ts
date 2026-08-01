export { createRigPluginClient, RigPluginApiError } from "./createRigPluginClient.js";
export { createRigPluginClient as connectRig } from "./createRigPluginClient.js";
export type {
    AgentMessageDelivery,
    ArchiveWorkspaceInput,
    CreateRigPluginClientOptions,
    CreateSessionInput,
    CreateWorkspaceInput,
    ListWorkspacesInput,
    RenameWorkspaceInput,
    RigPluginClient,
    RigProject,
    RigSession,
    RigWorkspace,
    RigWorkspaceStatus,
    SendAgentMessageInput,
} from "./types.js";
export {
    agentMessageDeliverySchema,
    archiveWorkspaceBodySchema,
    archiveWorkspaceInputSchema,
    createRigPluginClientOptionsSchema,
    createSessionInputSchema,
    createWorkspaceBodySchema,
    createWorkspaceInputSchema,
    listProjectsResponseSchema,
    listSessionsResponseSchema,
    listWorkspacesInputSchema,
    listWorkspacesResponseSchema,
    renameWorkspaceInputSchema,
    renameWorkspaceBodySchema,
    rigProjectSchema,
    rigSessionSchema,
    rigWorkspaceSchema,
    rigWorkspaceStatusSchema,
    sendAgentMessageInputSchema,
    sendAgentMessageBodySchema,
    sessionResponseSchema,
    workspaceResponseSchema,
} from "./types.js";

import { createRigPluginClient } from "./createRigPluginClient.js";

/** The extension's ready-to-use connection to its owning Rig daemon. */
export const rig = createRigPluginClient();
