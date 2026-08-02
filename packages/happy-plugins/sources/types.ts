import { type Static, type TSchema, Type } from "@sinclair/typebox";

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

export const happyMcpTextContentSchema = Type.Object(
    { text: Type.String(), type: Type.Literal("text") },
    exact,
);
export const happyMcpImageContentSchema = Type.Object(
    {
        data: Type.String(),
        mimeType: Type.String({ pattern: "^image/" }),
        type: Type.Literal("image"),
    },
    exact,
);
export const happyMcpContentSchema = Type.Union([
    happyMcpTextContentSchema,
    happyMcpImageContentSchema,
]);
export type HappyMcpContent = Static<typeof happyMcpContentSchema>;

export const happyMcpToolResultSchema = Type.Object(
    {
        content: Type.Array(happyMcpContentSchema, { maxItems: 128 }),
        isError: Type.Optional(Type.Boolean()),
        structuredContent: Type.Optional(Type.Unknown()),
    },
    exact,
);
export type HappyMcpToolResult = Static<typeof happyMcpToolResultSchema>;

/**
 * The JSON Schema subset accepted at the plugin socket boundary.
 *
 * `defineMcpTool` additionally checks the complete in-process value with TypeBox's schema guard
 * before this serializable form crosses the socket.
 */
export const happyMcpInputSchemaSchema = Type.Object(
    {
        additionalProperties: Type.Optional(Type.Union([Type.Boolean(), Type.Unknown()])),
        properties: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
        required: Type.Optional(Type.Array(Type.String(), { uniqueItems: true })),
        type: Type.Literal("object"),
    },
    { additionalProperties: true },
);
export type HappyMcpInputSchema = Static<typeof happyMcpInputSchemaSchema>;

export const happyMcpToolRegistrationSchema = Type.Object(
    {
        _meta: Type.Optional(
            Type.Object(
                {
                    ui: Type.Object(
                        {
                            visibility: Type.Array(
                                Type.Union([Type.Literal("model"), Type.Literal("app")]),
                                { maxItems: 2, minItems: 1, uniqueItems: true },
                            ),
                        },
                        exact,
                    ),
                },
                exact,
            ),
        ),
        description: Type.String({ minLength: 1 }),
        inputSchema: happyMcpInputSchemaSchema,
        name: nonEmptyText,
    },
    exact,
);
export type HappyMcpToolRegistration = Static<typeof happyMcpToolRegistrationSchema>;

export const happyMcpServerRegistrationSchema = Type.Object(
    {
        name: nonEmptyText,
        tools: Type.Array(happyMcpToolRegistrationSchema, { maxItems: 64, minItems: 1 }),
        version: Type.Optional(nonEmptyText),
    },
    exact,
);
export type HappyMcpServerRegistration = Static<typeof happyMcpServerRegistrationSchema>;

export const registerHappyMcpServerResponseSchema = Type.Object(
    { registrationId: nonEmptyText },
    exact,
);
export type RegisterHappyMcpServerResponse = Static<typeof registerHappyMcpServerResponseSchema>;

export const happyMcpCallEventSchema = Type.Object(
    {
        arguments: Type.Unknown(),
        callId: nonEmptyText,
        tool: nonEmptyText,
        type: Type.Literal("call"),
    },
    exact,
);
export const happyMcpCancelEventSchema = Type.Object(
    { callId: nonEmptyText, type: Type.Literal("cancel") },
    exact,
);
export const happyMcpEventSchema = Type.Union([happyMcpCallEventSchema, happyMcpCancelEventSchema]);
export type HappyMcpEvent = Static<typeof happyMcpEventSchema>;

export const happyMcpCallCompletionSchema = Type.Union([
    Type.Object({ result: happyMcpToolResultSchema }, exact),
    Type.Object({ error: nonEmptyText }, exact),
]);
export type HappyMcpCallCompletion = Static<typeof happyMcpCallCompletionSchema>;

export interface HappyMcpToolContext {
    /** Aborted when Rig cancels the model call, times it out, or retires this plugin generation. */
    readonly signal: AbortSignal;
}

export interface HappyMcpTool<TInputSchema extends TSchema = TSchema> {
    readonly description: string;
    readonly inputSchema: TInputSchema;
    readonly name: string;
    /**
     * Official MCP Apps visibility. Omit it to make the tool available to both models and apps.
     */
    readonly visibility?: readonly ("app" | "model")[];
    execute(
        input: Static<TInputSchema>,
        context: HappyMcpToolContext,
    ): HappyMcpToolResult | Promise<HappyMcpToolResult>;
}

export interface StartHappyMcpServerOptions {
    name: string;
    tools: readonly HappyMcpTool[];
    version?: string;
}

export interface HappyMcpServer {
    /** Most recent connection failure while Happy is restoring this server. */
    readonly failure: string | undefined;
    readonly name: string;
    /** The current registration. It changes when an interrupted stream is restored. */
    readonly registrationId: string;
    readonly status: HappyMcpServerStatus;
    close(): Promise<void>;
}
export type HappyMcpServerStatus = "closed" | "connected" | "reconnecting";

export const HAPPY_PLUGIN_MAX_APPS = 8;
export const HAPPY_PLUGIN_MAX_APP_RESOURCES = 64;
export const HAPPY_PLUGIN_MAX_RESOURCE_BYTES = 256 * 1024;
export const HAPPY_PLUGIN_MAX_APP_BYTES = 1024 * 1024;
export const HAPPY_PLUGIN_MAX_STORAGE_KEYS = 1_024;
export const HAPPY_PLUGIN_MAX_STORAGE_VALUE_BYTES = 64 * 1024;
export const HAPPY_PLUGIN_MAX_STORAGE_BYTES = 5 * 1024 * 1024;

export const happyPluginAppIdSchema = Type.String({
    maxLength: 64,
    minLength: 1,
    pattern: "^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$",
});
export const happyPluginResourcePathSchema = Type.String({
    maxLength: 160,
    minLength: 1,
    pattern: "^(?!/)(?!.*//)(?!.*(?:^|/)\\.{1,2}(?:/|$))(?!.*\\\\)[A-Za-z0-9][A-Za-z0-9._/-]*$",
});
export const happyPluginResourceUriSchema = Type.String({
    pattern: "^ui://[^/?#]+/[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?/[A-Za-z0-9][A-Za-z0-9._/-]*$",
});
export const happyPluginResourceMediaTypeSchema = Type.Union([
    Type.Literal("application/json"),
    Type.Literal("font/woff2"),
    Type.Literal("image/jpeg"),
    Type.Literal("image/png"),
    Type.Literal("image/svg+xml"),
    Type.Literal("image/webp"),
    Type.Literal("text/css"),
    Type.Literal("text/html"),
    Type.Literal("text/javascript"),
]);
export type HappyPluginResourceMediaType = Static<typeof happyPluginResourceMediaTypeSchema>;

export const happyPluginAppSidebarSchema = Type.Object(
    {
        icon: Type.Optional(happyPluginResourcePathSchema),
        label: Type.String({ maxLength: 64, minLength: 1 }),
        order: Type.Integer({ maximum: 1_000, minimum: -1_000 }),
    },
    exact,
);
export type HappyPluginAppSidebar = Static<typeof happyPluginAppSidebarSchema>;

export const happyPluginAppManifestSchema = Type.Object(
    {
        id: happyPluginAppIdSchema,
        page: happyPluginResourcePathSchema,
        root: happyPluginResourcePathSchema,
        sidebar: happyPluginAppSidebarSchema,
        title: Type.String({ maxLength: 128, minLength: 1 }),
    },
    exact,
);
export type HappyPluginAppManifest = Static<typeof happyPluginAppManifestSchema>;

export const happyPluginVersionSchema = Type.String({
    default: "0.0.0",
    pattern:
        "^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:-((?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)(?:\\.(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$",
});
export type HappyPluginVersion = Static<typeof happyPluginVersionSchema>;

export const happyPluginManifestSchema = Type.Object(
    {
        apps: Type.Optional(
            Type.Array(happyPluginAppManifestSchema, {
                maxItems: HAPPY_PLUGIN_MAX_APPS,
                uniqueItems: true,
            }),
        ),
        description: Type.String({ minLength: 1 }),
        entry: Type.String({ pattern: "^(?!.*\\.d\\.ts$).+\\.ts$" }),
        icon: Type.String({ pattern: "^.+\\.[pP][nN][gG]$" }),
        name: Type.String({ minLength: 1 }),
        version: Type.Optional(happyPluginVersionSchema),
    },
    exact,
);
export type HappyPluginManifest = Static<typeof happyPluginManifestSchema>;

export const happyPluginAppResourceSummarySchema = Type.Object(
    {
        mimeType: Type.String(),
        path: happyPluginResourcePathSchema,
        size: Type.Integer({ maximum: HAPPY_PLUGIN_MAX_RESOURCE_BYTES, minimum: 0 }),
        uri: happyPluginResourceUriSchema,
    },
    exact,
);
export type HappyPluginAppResourceSummary = Static<typeof happyPluginAppResourceSummarySchema>;

export const happyPluginAppToolSummarySchema = Type.Object(
    {
        _meta: Type.Object(
            {
                ui: Type.Object(
                    {
                        resourceUri: Type.String({ pattern: "^ui://" }),
                        visibility: Type.Array(
                            Type.Union([Type.Literal("model"), Type.Literal("app")]),
                            { maxItems: 2, minItems: 1, uniqueItems: true },
                        ),
                    },
                    exact,
                ),
            },
            exact,
        ),
        description: nonEmptyText,
        name: nonEmptyText,
        server: nonEmptyText,
    },
    exact,
);
export type HappyPluginAppToolSummary = Static<typeof happyPluginAppToolSummarySchema>;

/**
 * One host-visible application.
 *
 * `id` is stable across restarts and replacements. `generation` is deliberately not: every plugin
 * process receives a new opaque value so an old renderer cannot address replacement code.
 */
export const happyPluginAppContributionSchema = Type.Object(
    {
        appId: happyPluginAppIdSchema,
        generation: nonEmptyText,
        id: nonEmptyText,
        page: happyPluginResourcePathSchema,
        pluginFolder: nonEmptyText,
        resourceUri: happyPluginResourceUriSchema,
        resources: Type.Array(happyPluginAppResourceSummarySchema, {
            maxItems: HAPPY_PLUGIN_MAX_APP_RESOURCES,
            minItems: 1,
        }),
        sidebar: happyPluginAppSidebarSchema,
        title: Type.String({ maxLength: 128, minLength: 1 }),
        tools: Type.Array(happyPluginAppToolSummarySchema),
    },
    exact,
);
export type HappyPluginAppContribution = Static<typeof happyPluginAppContributionSchema>;

export const happyProviderUsageWindowSchema = Type.Object(
    {
        durationMs: Type.Union([Type.Number(), Type.Null()]),
        resetsAt: Type.Union([Type.Number(), Type.Null()]),
        startsAt: Type.Union([Type.Number(), Type.Null()]),
        usedPercent: Type.Number(),
    },
    exact,
);
export type HappyProviderUsageWindow = Static<typeof happyProviderUsageWindowSchema>;

export const happyProviderUsageCreditsSchema = Type.Object(
    {
        available: Type.Boolean(),
        remainingCents: Type.Union([Type.Number(), Type.Null()]),
        unlimited: Type.Boolean(),
        usedPercent: Type.Union([Type.Number(), Type.Null()]),
    },
    exact,
);
export type HappyProviderUsageCredits = Static<typeof happyProviderUsageCreditsSchema>;

export const happyProviderUsageSchema = Type.Object(
    {
        capturedAt: Type.Number(),
        credits: Type.Union([happyProviderUsageCreditsSchema, Type.Null()]),
        exhausted: Type.Boolean(),
        planName: Type.Union([Type.String(), Type.Null()]),
        providerId: nonEmptyText,
        vendor: Type.Union([Type.Literal("claude"), Type.Literal("codex"), Type.Literal("grok")]),
        windows: Type.Object(
            {
                fiveHour: Type.Union([happyProviderUsageWindowSchema, Type.Null()]),
                monthly: Type.Union([happyProviderUsageWindowSchema, Type.Null()]),
                weekly: Type.Union([happyProviderUsageWindowSchema, Type.Null()]),
            },
            exact,
        ),
    },
    exact,
);
export type HappyProviderUsage = Static<typeof happyProviderUsageSchema>;

export const happyProviderUsageEntrySchema = Type.Object(
    {
        checkedAt: Type.Union([Type.Number(), Type.Null()]),
        error: Type.Union([Type.String(), Type.Null()]),
        providerId: nonEmptyText,
        usage: Type.Union([happyProviderUsageSchema, Type.Null()]),
    },
    exact,
);
export type HappyProviderUsageEntry = Static<typeof happyProviderUsageEntrySchema>;

export const listHappyProviderUsageResponseSchema = Type.Object(
    {
        providers: Type.Array(happyProviderUsageEntrySchema),
    },
    exact,
);

export const happyPluginTestSeedSchema = Type.Object(
    {
        providerUsage: Type.Optional(Type.Array(happyProviderUsageEntrySchema)),
        projects: Type.Optional(Type.Array(happyProjectSchema)),
        sessions: Type.Optional(Type.Array(happySessionSchema)),
        workspaces: Type.Optional(Type.Array(happyWorkspaceSchema)),
    },
    exact,
);
export type HappyPluginTestSeed = Static<typeof happyPluginTestSeedSchema>;

export const happyPluginTestRequestSchema = Type.Object(
    {
        body: Type.Optional(Type.Unknown()),
        method: nonEmptyText,
        path: nonEmptyText,
    },
    exact,
);
export type HappyPluginTestRequest = Static<typeof happyPluginTestRequestSchema>;

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
    /** Contribute MCP tools to ordinary Happy agent sessions. */
    readonly mcp: {
        startServer(options: StartHappyMcpServerOptions): Promise<HappyMcpServer>;
    };
    /** Inspect provider-neutral account usage held by the local daemon. */
    readonly providers: {
        usage(): Promise<readonly HappyProviderUsageEntry[]>;
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
