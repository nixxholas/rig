export { createHappyPluginClient, HappyPluginApiError } from "./createHappyPluginClient.js";
export { createHappyPluginClient as connectHappy } from "./createHappyPluginClient.js";
export type {
    AgentMessageDelivery,
    ArchiveWorkspaceInput,
    CreateHappyPluginClientOptions,
    CreateSessionInput,
    CreateWorkspaceInput,
    HappyPluginClient,
    HappyProject,
    HappySession,
    HappyWorkspace,
    HappyWorkspaceStatus,
    ListWorkspacesInput,
    RenameWorkspaceInput,
    SendAgentMessageInput,
} from "./types.js";
export {
    agentMessageDeliverySchema,
    archiveWorkspaceBodySchema,
    archiveWorkspaceInputSchema,
    createHappyPluginClientOptionsSchema,
    createSessionInputSchema,
    createWorkspaceBodySchema,
    createWorkspaceInputSchema,
    happyProjectSchema,
    happySessionSchema,
    happyWorkspaceSchema,
    happyWorkspaceStatusSchema,
    listProjectsResponseSchema,
    listSessionsResponseSchema,
    listWorkspacesInputSchema,
    listWorkspacesResponseSchema,
    renameWorkspaceInputSchema,
    renameWorkspaceBodySchema,
    sendAgentMessageInputSchema,
    sendAgentMessageBodySchema,
    sessionResponseSchema,
    workspaceResponseSchema,
} from "./types.js";

import { createHappyPluginClient } from "./createHappyPluginClient.js";

/** The plugin's ready-to-use connection to its owning Happy daemon. */
export const happy = createHappyPluginClient();
