export { createHappyPluginClient, HappyPluginApiError } from "./createHappyPluginClient.js";
export { createHappyPluginClient as connectHappy } from "./createHappyPluginClient.js";
export { createHappyMcpToolName, normalizeHappyMcpName } from "./createHappyMcpToolName.js";
export { happyMcpCompletionToResult } from "./happyMcpCompletionToResult.js";
export {
    createHappyPluginTestHost,
    type CreateHappyPluginTestHostOptions,
    type HappyPluginTestHost,
} from "./createHappyPluginTestHost.js";
export { defineMcpTool } from "./startHappyMcpServer.js";
export { Type } from "@sinclair/typebox";
export type { Static, TSchema } from "@sinclair/typebox";
export type {
    AgentMessageDelivery,
    ArchiveWorkspaceInput,
    CreateHappyPluginClientOptions,
    CreateSessionInput,
    CreateWorkspaceInput,
    HappyPluginClient,
    HappyMcpCallCompletion,
    HappyMcpContent,
    HappyMcpEvent,
    HappyMcpInputSchema,
    HappyMcpServer,
    HappyMcpServerRegistration,
    HappyMcpServerStatus,
    HappyMcpTool,
    HappyMcpToolContext,
    HappyMcpToolRegistration,
    HappyMcpToolResult,
    HappyPluginTestRequest,
    HappyPluginTestSeed,
    HappyProject,
    HappySession,
    HappyWorkspace,
    HappyWorkspaceStatus,
    ListWorkspacesInput,
    RenameWorkspaceInput,
    SendAgentMessageInput,
    StartHappyMcpServerOptions,
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
    happyMcpCallCompletionSchema,
    happyMcpCallEventSchema,
    happyMcpCancelEventSchema,
    happyMcpContentSchema,
    happyMcpEventSchema,
    happyMcpImageContentSchema,
    happyMcpInputSchemaSchema,
    happyMcpServerRegistrationSchema,
    happyMcpTextContentSchema,
    happyMcpToolRegistrationSchema,
    happyMcpToolResultSchema,
    happyPluginTestRequestSchema,
    happyPluginTestSeedSchema,
    happySessionSchema,
    happyWorkspaceSchema,
    happyWorkspaceStatusSchema,
    listProjectsResponseSchema,
    listSessionsResponseSchema,
    listWorkspacesInputSchema,
    listWorkspacesResponseSchema,
    renameWorkspaceInputSchema,
    renameWorkspaceBodySchema,
    registerHappyMcpServerResponseSchema,
    sendAgentMessageInputSchema,
    sendAgentMessageBodySchema,
    sessionResponseSchema,
    workspaceResponseSchema,
} from "./types.js";

import { createHappyPluginClient } from "./createHappyPluginClient.js";

/** The plugin's ready-to-use connection to its owning Happy daemon. */
export const happy = createHappyPluginClient();
