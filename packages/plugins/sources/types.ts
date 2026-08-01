import { type Static, Type } from "@sinclair/typebox";

const exact = { additionalProperties: false } as const;
const nonEmptyText = Type.String({ minLength: 1 });

export const rigProjectSchema = Type.Object(
    {
        archivedAt: Type.Optional(Type.Number()),
        id: nonEmptyText,
        name: nonEmptyText,
        path: nonEmptyText,
    },
    exact,
);
export type RigProject = Static<typeof rigProjectSchema>;

export const rigWorkspaceStatusSchema = Type.Union([
    Type.Literal("initializing"),
    Type.Literal("ready"),
    Type.Literal("failed"),
    Type.Literal("archiving"),
    Type.Literal("archived"),
]);
export type RigWorkspaceStatus = Static<typeof rigWorkspaceStatusSchema>;

export const rigWorkspaceSchema = Type.Object(
    {
        archivedAt: Type.Optional(Type.Number()),
        baseRef: Type.Optional(Type.String()),
        error: Type.Optional(Type.String()),
        id: nonEmptyText,
        name: nonEmptyText,
        path: nonEmptyText,
        projectId: nonEmptyText,
        status: rigWorkspaceStatusSchema,
        version: Type.Integer({ minimum: 0 }),
    },
    exact,
);
export type RigWorkspace = Static<typeof rigWorkspaceSchema>;

export const rigSessionSchema = Type.Object(
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
export type RigSession = Static<typeof rigSessionSchema>;

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
    { projects: Type.Array(rigProjectSchema) },
    exact,
);
export const listWorkspacesResponseSchema = Type.Object(
    { workspaces: Type.Array(rigWorkspaceSchema) },
    exact,
);
export const workspaceResponseSchema = Type.Object({ workspace: rigWorkspaceSchema }, exact);
export const listSessionsResponseSchema = Type.Object(
    { sessions: Type.Array(rigSessionSchema) },
    exact,
);
export const sessionResponseSchema = Type.Object({ session: rigSessionSchema }, exact);

export const createRigPluginClientOptionsSchema = Type.Object(
    {
        socketPath: Type.Optional(Type.String()),
        token: Type.Optional(Type.String()),
    },
    exact,
);
export type CreateRigPluginClientOptions = Static<typeof createRigPluginClientOptionsSchema>;

/**
 * The public API available to a running Rig extension.
 *
 * Use the exported {@link rig} singleton in normal extension code. Rig injects and authenticates
 * its transport when the extension process starts.
 */
export interface RigPluginClient {
    /** Send a durable notification to an agent identified by a session's stable Agent ID. */
    readonly agents: {
        sendMessage(input: SendAgentMessageInput): Promise<AgentMessageDelivery>;
    };
    /** Inspect projects known to the local Rig daemon. */
    readonly projects: {
        list(): Promise<readonly RigProject[]>;
    };
    /** Inspect existing sessions or create a new agent session. */
    readonly sessions: {
        create(input: CreateSessionInput): Promise<RigSession>;
        list(): Promise<readonly RigSession[]>;
    };
    /** Inspect and mutate Rig-managed Git workspaces. */
    readonly workspaces: {
        archive(input: ArchiveWorkspaceInput): Promise<RigWorkspace>;
        create(input: CreateWorkspaceInput): Promise<RigWorkspace>;
        list(input?: ListWorkspacesInput): Promise<readonly RigWorkspace[]>;
        rename(input: RenameWorkspaceInput): Promise<RigWorkspace>;
    };
}
