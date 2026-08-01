import { type Static, Type } from "@sinclair/typebox";

const exact = { additionalProperties: false } as const;
const nonEmptyText = Type.String({ minLength: 1 });

export const happyProjectSchema = Type.Object(
    {
        archivedAt: Type.Optional(Type.Number()),
        id: nonEmptyText,
        name: nonEmptyText,
        path: nonEmptyText,
    },
    exact,
);
export type HappyProject = Static<typeof happyProjectSchema>;

export const happyWorkspaceStatusSchema = Type.Union([
    Type.Literal("initializing"),
    Type.Literal("ready"),
    Type.Literal("failed"),
    Type.Literal("archiving"),
    Type.Literal("archived"),
]);
export type HappyWorkspaceStatus = Static<typeof happyWorkspaceStatusSchema>;

export const happyWorkspaceSchema = Type.Object(
    {
        archivedAt: Type.Optional(Type.Number()),
        baseRef: Type.Optional(Type.String()),
        error: Type.Optional(Type.String()),
        id: nonEmptyText,
        name: nonEmptyText,
        path: nonEmptyText,
        projectId: nonEmptyText,
        status: happyWorkspaceStatusSchema,
        version: Type.Integer({ minimum: 0 }),
    },
    exact,
);
export type HappyWorkspace = Static<typeof happyWorkspaceSchema>;

export const happySessionSchema = Type.Object(
    {
        agentId: nonEmptyText,
        archived: Type.Boolean(),
        cwd: nonEmptyText,
        id: nonEmptyText,
        projectId: nonEmptyText,
        status: nonEmptyText,
        title: Type.Optional(Type.String()),
        workspaceId: Type.Optional(nonEmptyText),
    },
    exact,
);
export type HappySession = Static<typeof happySessionSchema>;

export const createWorkspaceInputSchema = Type.Object(
    {
        baseRef: Type.Optional(Type.String()),
        name: nonEmptyText,
        projectId: nonEmptyText,
    },
    exact,
);
export type CreateWorkspaceInput = Static<typeof createWorkspaceInputSchema>;

export const createWorkspaceBodySchema = Type.Omit(createWorkspaceInputSchema, ["projectId"]);

export const renameWorkspaceInputSchema = Type.Object(
    {
        name: nonEmptyText,
        projectId: nonEmptyText,
        version: Type.Integer({ minimum: 0 }),
        workspaceId: nonEmptyText,
    },
    exact,
);
export type RenameWorkspaceInput = Static<typeof renameWorkspaceInputSchema>;

export const renameWorkspaceBodySchema = Type.Pick(renameWorkspaceInputSchema, ["name", "version"]);

export const archiveWorkspaceInputSchema = Type.Object(
    {
        projectId: nonEmptyText,
        version: Type.Integer({ minimum: 0 }),
        workspaceId: nonEmptyText,
    },
    exact,
);
export type ArchiveWorkspaceInput = Static<typeof archiveWorkspaceInputSchema>;

export const archiveWorkspaceBodySchema = Type.Pick(archiveWorkspaceInputSchema, ["version"]);

export const listWorkspacesInputSchema = Type.Object(
    { projectId: Type.Optional(nonEmptyText) },
    exact,
);
export type ListWorkspacesInput = Static<typeof listWorkspacesInputSchema>;

export const createSessionInputSchema = Type.Object(
    {
        appendSystemPrompt: Type.Optional(Type.String()),
        cwd: nonEmptyText,
        effort: Type.Optional(Type.String()),
        modelId: Type.Optional(Type.String()),
        providerId: Type.Optional(Type.String()),
        workspaceId: Type.Optional(Type.String()),
    },
    exact,
);
export type CreateSessionInput = Static<typeof createSessionInputSchema>;

export const sendAgentMessageInputSchema = Type.Object(
    {
        agentId: nonEmptyText,
        message: nonEmptyText,
    },
    exact,
);
export type SendAgentMessageInput = Static<typeof sendAgentMessageInputSchema>;

export const sendAgentMessageBodySchema = Type.Pick(sendAgentMessageInputSchema, ["message"]);

export const agentMessageDeliverySchema = Type.Object(
    {
        delivered: Type.Literal(true),
        runId: nonEmptyText,
        sessionId: nonEmptyText,
    },
    exact,
);
export type AgentMessageDelivery = Static<typeof agentMessageDeliverySchema>;

export const listProjectsResponseSchema = Type.Object(
    { projects: Type.Array(happyProjectSchema) },
    exact,
);
export const listWorkspacesResponseSchema = Type.Object(
    { workspaces: Type.Array(happyWorkspaceSchema) },
    exact,
);
export const workspaceResponseSchema = Type.Object({ workspace: happyWorkspaceSchema }, exact);
export const listSessionsResponseSchema = Type.Object(
    { sessions: Type.Array(happySessionSchema) },
    exact,
);
export const sessionResponseSchema = Type.Object({ session: happySessionSchema }, exact);

export const createHappyPluginClientOptionsSchema = Type.Object(
    {
        socketPath: Type.Optional(Type.String()),
        token: Type.Optional(Type.String()),
    },
    exact,
);
export type CreateHappyPluginClientOptions = Static<typeof createHappyPluginClientOptionsSchema>;

/**
 * The public API available to a running Happy plugin.
 *
 * Use the exported {@link happy} singleton in normal plugin code. Happy injects and authenticates
 * its transport when the plugin process starts.
 */
export interface HappyPluginClient {
    /** Send a durable notification to an agent identified by a session's stable Agent ID. */
    readonly agents: {
        sendMessage(input: SendAgentMessageInput): Promise<AgentMessageDelivery>;
    };
    /** Inspect projects known to the local Happy daemon. */
    readonly projects: {
        list(): Promise<readonly HappyProject[]>;
    };
    /** Inspect existing sessions or create a new agent session. */
    readonly sessions: {
        create(input: CreateSessionInput): Promise<HappySession>;
        list(): Promise<readonly HappySession[]>;
    };
    /** Inspect and mutate Happy-managed Git workspaces. */
    readonly workspaces: {
        archive(input: ArchiveWorkspaceInput): Promise<HappyWorkspace>;
        create(input: CreateWorkspaceInput): Promise<HappyWorkspace>;
        list(input?: ListWorkspacesInput): Promise<readonly HappyWorkspace[]>;
        rename(input: RenameWorkspaceInput): Promise<HappyWorkspace>;
    };
}
