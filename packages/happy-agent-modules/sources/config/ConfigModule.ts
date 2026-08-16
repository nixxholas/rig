import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import type { AgentModule } from "@slopus/happy-agent-base";
import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { parse, TomlDate, type TomlTable, type TomlValue } from "smol-toml";

const MAX_PATH_LENGTH = 4_096;
const MAX_CONFIG_STRING_LENGTH = 16_384;
const MAX_CONFIG_FILE_BYTES = 1_048_576;
const MAX_CONFIG_ARRAY_ITEMS = 256;
const MAX_PROTECTED_PATHS = 128;
const MAX_CONFIG_TABLE_ENTRIES = 512;
const MAX_PROVIDER_COUNT = 64;
const MAX_UNKNOWN_SETTINGS = 256;
const MAX_PROVENANCE_ENTRIES = 512;
const MAX_INFERENCE_MAX_RETRIES = 100;
const MAX_TOOL_RESULT_RETENTION_DAYS = 36_500;
const MAX_MCP_TIMEOUT_SECONDS = 600;

const pathSchema = Type.String({
    minLength: 1,
    maxLength: MAX_PATH_LENGTH,
    pattern: "^[^\\u0000]+$",
});
const configStringSchema = Type.String({ maxLength: MAX_CONFIG_STRING_LENGTH });
const boundedStringArraySchema = Type.Array(configStringSchema, {
    maxItems: MAX_CONFIG_ARRAY_ITEMS,
});
const projectRelativePathSchema = Type.String({
    minLength: 1,
    maxLength: 512,
    pattern: "^(?!/)(?!~(?:/|$))(?!.*(?:^|/)\\.\\.(?:/|$))[^\\\\\\r\\n]+$",
});
const projectRelativePathsSchema = Type.Array(projectRelativePathSchema, {
    maxItems: MAX_PROTECTED_PATHS,
    uniqueItems: true,
});
const permissionModeSchema = Type.Union([
    Type.Literal("auto"),
    Type.Literal("read_only"),
    Type.Literal("workspace_write"),
    Type.Literal("full_access"),
]);
const effortSchema = Type.Union([
    Type.Literal("off"),
    Type.Literal("low"),
    Type.Literal("medium"),
    Type.Literal("high"),
    Type.Literal("xhigh"),
    Type.Literal("max"),
    Type.Literal("ultra"),
    configStringSchema,
]);
const serviceTierSchema = Type.Literal("fast");
const defaultServiceTierSchema = Type.Union([serviceTierSchema, Type.Literal("default")]);
const p2pShareSchema = Type.Union([
    Type.Literal("owner_only"),
    Type.Literal("shared"),
    Type.Literal("disabled"),
]);
const p2pInstanceIdSchema = Type.String({
    minLength: 2,
    maxLength: 32,
    pattern: "^[a-z][a-z0-9]*$",
});
const logLevelSchema = Type.Union([
    Type.Literal("trace"),
    Type.Literal("debug"),
    Type.Literal("info"),
    Type.Literal("warn"),
    Type.Literal("error"),
    Type.Literal("fatal"),
]);
const traceEndpointSchema = Type.String({
    minLength: 1,
    maxLength: 2_048,
    pattern: "^https?://[^\\s]+$",
});

const defaultsInputSchema = Type.Object(
    {
        effort: Type.Optional(configStringSchema),
        instructions: Type.Optional(configStringSchema),
        model: Type.Optional(configStringSchema),
        permission_mode: Type.Optional(permissionModeSchema),
        provider: Type.Optional(configStringSchema),
        service_tier: Type.Optional(defaultServiceTierSchema),
    },
    { additionalProperties: false },
);
const settingsInputSchema = Type.Object(
    {
        compact_completed_turns: Type.Optional(Type.Boolean()),
        completion_chime: Type.Optional(Type.Boolean()),
        daemon_heap_snapshots: Type.Optional(Type.Boolean()),
        durable_global_event_queue: Type.Optional(Type.Boolean()),
        happy_integration: Type.Optional(Type.Boolean()),
        inference_max_retries: Type.Optional(
            Type.Integer({ minimum: 0, maximum: MAX_INFERENCE_MAX_RETRIES }),
        ),
        show_reasoning: Type.Optional(Type.Boolean()),
        show_usage: Type.Optional(Type.Boolean()),
        tool_result_retention_days: Type.Optional(
            Type.Integer({ minimum: 0, maximum: MAX_TOOL_RESULT_RETENTION_DAYS }),
        ),
    },
    { additionalProperties: false },
);
const providerCommonInput = {
    credential_isolation: Type.Optional(Type.Literal(true)),
    enabled: Type.Optional(Type.Boolean()),
    exclude_models: Type.Optional(boundedStringArraySchema),
    include_models: Type.Optional(boundedStringArraySchema),
    p2p_share: Type.Optional(p2pShareSchema),
};
const providerInputSchemas = {
    bedrock: Type.Object(
        {
            ...providerCommonInput,
            bearer_token: Type.Optional(configStringSchema),
            bearer_token_env_var: Type.Optional(configStringSchema),
            model_overrides: Type.Optional(
                Type.Record(
                    configStringSchema,
                    Type.Object(
                        {
                            endpoint: Type.Optional(configStringSchema),
                            region: Type.Optional(configStringSchema),
                            transport: Type.Optional(
                                Type.Union([Type.Literal("mantle"), Type.Literal("runtime")]),
                            ),
                        },
                        { additionalProperties: true },
                    ),
                    { maxProperties: MAX_CONFIG_TABLE_ENTRIES },
                ),
            ),
            region: Type.Optional(configStringSchema),
            search_model: Type.Optional(configStringSchema),
            type: Type.Optional(Type.Literal("bedrock")),
        },
        { additionalProperties: false },
    ),
    claude: Type.Object(
        {
            ...providerCommonInput,
            api_key: Type.Optional(configStringSchema),
            auth_token: Type.Optional(configStringSchema),
            config_dir: Type.Optional(pathSchema),
            executable: Type.Optional(pathSchema),
            oauth_token: Type.Optional(configStringSchema),
            type: Type.Optional(Type.Literal("claude")),
        },
        { additionalProperties: false },
    ),
    codex: Type.Object(
        {
            ...providerCommonInput,
            api_key: Type.Optional(configStringSchema),
            auth_file: Type.Optional(pathSchema),
            base_url: Type.Optional(configStringSchema),
            transport: Type.Optional(
                Type.Union([
                    Type.Literal("auto"),
                    Type.Literal("sse"),
                    Type.Literal("websocket"),
                    Type.Literal("websocket-cached"),
                ]),
            ),
            type: Type.Optional(Type.Literal("codex")),
        },
        { additionalProperties: false },
    ),
    grok: Type.Object(
        {
            ...providerCommonInput,
            api_key: Type.Optional(configStringSchema),
            auth_file: Type.Optional(pathSchema),
            base_url: Type.Optional(configStringSchema),
            type: Type.Optional(Type.Literal("grok")),
        },
        { additionalProperties: false },
    ),
} as const;
const providerInputSchema = Type.Union([
    providerInputSchemas.bedrock,
    providerInputSchemas.claude,
    providerInputSchemas.codex,
    providerInputSchemas.grok,
]);
const providerMapInputSchema = Type.Record(configStringSchema, providerInputSchema, {
    maxProperties: MAX_PROVIDER_COUNT,
});
const dockerInputSchema = Type.Object(
    {
        container: Type.Optional(configStringSchema),
        env: Type.Optional(
            Type.Record(configStringSchema, configStringSchema, {
                maxProperties: MAX_CONFIG_TABLE_ENTRIES,
            }),
        ),
        image: Type.Optional(configStringSchema),
        mounts: Type.Optional(
            Type.Array(
                Type.Object(
                    {
                        read_only: Type.Optional(Type.Boolean()),
                        source: pathSchema,
                        target: configStringSchema,
                    },
                    { additionalProperties: true },
                ),
                { maxItems: MAX_CONFIG_ARRAY_ITEMS },
            ),
        ),
        name: Type.Optional(configStringSchema),
        socket_path: Type.Optional(pathSchema),
        workdir: Type.Optional(configStringSchema),
    },
    { additionalProperties: false },
);
const mcpInputSchema = Type.Record(
    configStringSchema,
    Type.Object(
        {
            args: Type.Optional(boundedStringArraySchema),
            bearer_token_env_var: Type.Optional(configStringSchema),
            command: Type.Optional(
                Type.String({ minLength: 1, maxLength: MAX_CONFIG_STRING_LENGTH }),
            ),
            cwd: Type.Optional(pathSchema),
            disabled_tools: Type.Optional(boundedStringArraySchema),
            enabled: Type.Optional(Type.Boolean()),
            enabled_tools: Type.Optional(boundedStringArraySchema),
            env: Type.Optional(
                Type.Record(configStringSchema, configStringSchema, {
                    maxProperties: MAX_CONFIG_TABLE_ENTRIES,
                }),
            ),
            http_headers: Type.Optional(
                Type.Record(configStringSchema, configStringSchema, {
                    maxProperties: MAX_CONFIG_TABLE_ENTRIES,
                }),
            ),
            oauth_client_id_env_var: Type.Optional(configStringSchema),
            oauth_client_secret_env_var: Type.Optional(configStringSchema),
            oauth_scopes: Type.Optional(boundedStringArraySchema),
            startup_timeout_sec: Type.Optional(
                Type.Number({ exclusiveMinimum: 0, maximum: MAX_MCP_TIMEOUT_SECONDS }),
            ),
            tool_timeout_sec: Type.Optional(
                Type.Number({ exclusiveMinimum: 0, maximum: MAX_MCP_TIMEOUT_SECONDS }),
            ),
            transport: Type.Optional(Type.Literal("http")),
            url: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_CONFIG_STRING_LENGTH })),
        },
        { additionalProperties: false },
    ),
    { maxProperties: MAX_CONFIG_TABLE_ENTRIES },
);
const partialValuesSchema = Type.Object(
    {
        docker: Type.Optional(dockerInputSchema),
        defaults: Type.Optional(defaultsInputSchema),
        features: Type.Optional(
            Type.Object(
                {
                    cross_workspace: Type.Optional(Type.Boolean()),
                    workflows: Type.Optional(Type.Boolean()),
                    workspaces: Type.Optional(Type.Boolean()),
                },
                { additionalProperties: false },
            ),
        ),
        mcp_servers: Type.Optional(mcpInputSchema),
        network: Type.Optional(
            Type.Object(
                {
                    allow_local_binding: Type.Optional(Type.Boolean()),
                    allowed_domains: Type.Optional(boundedStringArraySchema),
                    allowed_loopback_ports: Type.Optional(
                        Type.Array(Type.Integer({ minimum: 1, maximum: 65_535 }), {
                            maxItems: MAX_CONFIG_ARRAY_ITEMS,
                        }),
                    ),
                    allowed_ports: Type.Optional(
                        Type.Array(Type.Integer({ minimum: 1, maximum: 65_535 }), {
                            maxItems: MAX_CONFIG_ARRAY_ITEMS,
                        }),
                    ),
                    denied_domains: Type.Optional(boundedStringArraySchema),
                },
                { additionalProperties: false },
            ),
        ),
        observation: Type.Optional(
            Type.Object(
                {
                    history_dump: Type.Optional(Type.Boolean()),
                    log_level: Type.Optional(logLevelSchema),
                    logs: Type.Optional(Type.Boolean()),
                    traces: Type.Optional(Type.Boolean()),
                    traces_endpoint: Type.Optional(traceEndpointSchema),
                },
                { additionalProperties: false },
            ),
        ),
        p2p: Type.Optional(
            Type.Object(
                {
                    direct: Type.Optional(
                        Type.Object(
                            { listen: Type.Optional(configStringSchema) },
                            {
                                additionalProperties: true,
                            },
                        ),
                    ),
                    enable_direct: Type.Optional(Type.Boolean()),
                    enable_iroh: Type.Optional(Type.Boolean()),
                    enable_ssh: Type.Optional(Type.Boolean()),
                    expose_api: Type.Optional(Type.Boolean()),
                    iroh: Type.Optional(
                        Type.Object(
                            { relay_url: Type.Optional(configStringSchema) },
                            {
                                additionalProperties: true,
                            },
                        ),
                    ),
                    name: Type.Optional(configStringSchema),
                    primary_id: Type.Optional(configStringSchema),
                    role: Type.Optional(
                        Type.Union([Type.Literal("primary"), Type.Literal("secondary")]),
                    ),
                },
                { additionalProperties: false },
            ),
        ),
        permissions: Type.Optional(
            Type.Object(
                {
                    protected_paths: Type.Optional(projectRelativePathsSchema),
                },
                { additionalProperties: false },
            ),
        ),
        presence: Type.Optional(
            Type.Object(
                {
                    current: Type.Optional(configStringSchema),
                    fallback: Type.Optional(configStringSchema),
                    states: Type.Optional(
                        Type.Record(
                            configStringSchema,
                            Type.Object(
                                {
                                    answer_wait: Type.Optional(
                                        Type.Union([configStringSchema, Type.Null()]),
                                    ),
                                    emoji: Type.Optional(configStringSchema),
                                    prompt: Type.Optional(configStringSchema),
                                    title: Type.Optional(configStringSchema),
                                },
                                { additionalProperties: false },
                            ),
                            { maxProperties: MAX_CONFIG_TABLE_ENTRIES },
                        ),
                    ),
                    until: Type.Optional(Type.Union([Type.String(), Type.Number()])),
                },
                { additionalProperties: false },
            ),
        ),
        provider_default_enable: Type.Optional(Type.Boolean()),
        providers: Type.Optional(providerMapInputSchema),
        settings: Type.Optional(settingsInputSchema),
        theme: Type.Optional(
            Type.Object(
                {
                    accent: Type.Optional(configStringSchema),
                    brand: Type.Optional(configStringSchema),
                    error: Type.Optional(configStringSchema),
                    primary: Type.Optional(configStringSchema),
                    secondary: Type.Optional(configStringSchema),
                    success: Type.Optional(configStringSchema),
                    warning: Type.Optional(configStringSchema),
                },
                { additionalProperties: false },
            ),
        ),
        workspace: Type.Optional(
            Type.Object(
                {
                    keep_copies_on_archive: Type.Optional(Type.Boolean()),
                    keep_worktrees_on_archive: Type.Optional(Type.Boolean()),
                    protected_sync: Type.Optional(projectRelativePathsSchema),
                    setup_commands: Type.Optional(boundedStringArraySchema),
                    sync: Type.Optional(projectRelativePathsSchema),
                },
                { additionalProperties: false },
            ),
        ),
    },
    { additionalProperties: false },
);

const providerRecordBase = {
    credentialIsolation: Type.Optional(Type.Literal(true)),
    enabled: Type.Boolean(),
    excludeModels: Type.Optional(boundedStringArraySchema),
    includeModels: Type.Optional(boundedStringArraySchema),
    p2pShare: Type.Optional(p2pShareSchema),
};
const providerSchemas = {
    bedrock: Type.Object(
        {
            ...providerRecordBase,
            bearerToken: Type.Optional(configStringSchema),
            bearerTokenEnvVar: Type.Optional(configStringSchema),
            modelOverrides: Type.Optional(
                Type.Record(
                    configStringSchema,
                    Type.Object(
                        {
                            endpoint: Type.Optional(configStringSchema),
                            region: Type.Optional(configStringSchema),
                            transport: Type.Optional(
                                Type.Union([Type.Literal("mantle"), Type.Literal("runtime")]),
                            ),
                        },
                        { additionalProperties: true },
                    ),
                    { maxProperties: MAX_CONFIG_TABLE_ENTRIES },
                ),
            ),
            region: Type.Optional(configStringSchema),
            searchModelId: Type.Optional(configStringSchema),
            type: Type.Literal("bedrock"),
        },
        { additionalProperties: false },
    ),
    claude: Type.Object(
        {
            ...providerRecordBase,
            apiKey: Type.Optional(configStringSchema),
            authToken: Type.Optional(configStringSchema),
            configDir: Type.Optional(pathSchema),
            executable: Type.Optional(pathSchema),
            oauthToken: Type.Optional(configStringSchema),
            type: Type.Literal("claude"),
        },
        { additionalProperties: false },
    ),
    codex: Type.Object(
        {
            ...providerRecordBase,
            apiKey: Type.Optional(configStringSchema),
            authFile: Type.Optional(pathSchema),
            baseUrl: Type.Optional(configStringSchema),
            transport: Type.Optional(
                Type.Union([
                    Type.Literal("auto"),
                    Type.Literal("sse"),
                    Type.Literal("websocket"),
                    Type.Literal("websocket-cached"),
                ]),
            ),
            type: Type.Literal("codex"),
        },
        { additionalProperties: false },
    ),
    grok: Type.Object(
        {
            ...providerRecordBase,
            apiKey: Type.Optional(configStringSchema),
            authFile: Type.Optional(pathSchema),
            baseUrl: Type.Optional(configStringSchema),
            type: Type.Literal("grok"),
        },
        { additionalProperties: false },
    ),
} as const;
const providerSchema = Type.Union([
    providerSchemas.bedrock,
    providerSchemas.claude,
    providerSchemas.codex,
    providerSchemas.grok,
]);

const resolvedValuesSchema = Type.Object(
    {
        docker: Type.Optional(
            Type.Object(
                {
                    container: Type.Optional(configStringSchema),
                    environment: Type.Optional(
                        Type.Record(configStringSchema, configStringSchema, {
                            maxProperties: MAX_CONFIG_TABLE_ENTRIES,
                        }),
                    ),
                    image: Type.Optional(configStringSchema),
                    mounts: Type.Optional(
                        Type.Array(
                            Type.Object(
                                {
                                    readOnly: Type.Optional(Type.Boolean()),
                                    source: pathSchema,
                                    target: configStringSchema,
                                },
                                { additionalProperties: false },
                            ),
                            { maxItems: MAX_CONFIG_ARRAY_ITEMS },
                        ),
                    ),
                    name: Type.Optional(configStringSchema),
                    socketPath: Type.Optional(pathSchema),
                    workingDirectory: configStringSchema,
                },
                { additionalProperties: false },
            ),
        ),
        defaults: Type.Object(
            {
                effort: Type.Optional(effortSchema),
                instructions: Type.Optional(configStringSchema),
                modelId: configStringSchema,
                permissionMode: permissionModeSchema,
                providerId: Type.Optional(configStringSchema),
                serviceTier: Type.Optional(serviceTierSchema),
            },
            { additionalProperties: false },
        ),
        features: Type.Object(
            {
                crossWorkspace: Type.Boolean(),
                workflows: Type.Boolean(),
                workspaces: Type.Boolean(),
            },
            { additionalProperties: false },
        ),
        mcpServers: Type.Record(
            configStringSchema,
            Type.Union([
                Type.Object(
                    {
                        args: Type.Optional(boundedStringArraySchema),
                        command: Type.String({ minLength: 1, maxLength: MAX_CONFIG_STRING_LENGTH }),
                        cwd: Type.Optional(pathSchema),
                        disabledTools: Type.Optional(boundedStringArraySchema),
                        enabled: Type.Optional(Type.Boolean()),
                        enabledTools: Type.Optional(boundedStringArraySchema),
                        env: Type.Optional(
                            Type.Record(configStringSchema, configStringSchema, {
                                maxProperties: MAX_CONFIG_TABLE_ENTRIES,
                            }),
                        ),
                        startupTimeoutMs: Type.Optional(
                            Type.Integer({ minimum: 1, maximum: MAX_MCP_TIMEOUT_SECONDS * 1_000 }),
                        ),
                        toolTimeoutMs: Type.Optional(
                            Type.Integer({ minimum: 1, maximum: MAX_MCP_TIMEOUT_SECONDS * 1_000 }),
                        ),
                        transport: Type.Literal("stdio"),
                    },
                    { additionalProperties: false },
                ),
                Type.Object(
                    {
                        bearerTokenEnvVar: Type.Optional(configStringSchema),
                        disabledTools: Type.Optional(boundedStringArraySchema),
                        enabled: Type.Optional(Type.Boolean()),
                        enabledTools: Type.Optional(boundedStringArraySchema),
                        headers: Type.Optional(
                            Type.Record(configStringSchema, configStringSchema, {
                                maxProperties: MAX_CONFIG_TABLE_ENTRIES,
                            }),
                        ),
                        oauthClientIdEnvVar: Type.Optional(configStringSchema),
                        oauthClientSecretEnvVar: Type.Optional(configStringSchema),
                        oauthScopes: Type.Optional(boundedStringArraySchema),
                        startupTimeoutMs: Type.Optional(
                            Type.Integer({ minimum: 1, maximum: MAX_MCP_TIMEOUT_SECONDS * 1_000 }),
                        ),
                        toolTimeoutMs: Type.Optional(
                            Type.Integer({ minimum: 1, maximum: MAX_MCP_TIMEOUT_SECONDS * 1_000 }),
                        ),
                        transport: Type.Literal("http"),
                        url: Type.String({ minLength: 1, maxLength: MAX_CONFIG_STRING_LENGTH }),
                    },
                    { additionalProperties: false },
                ),
            ]),
            { maxProperties: MAX_CONFIG_TABLE_ENTRIES },
        ),
        network: Type.Optional(
            Type.Object(
                {
                    allowLocalBinding: Type.Optional(Type.Boolean()),
                    allowedDomains: Type.Optional(boundedStringArraySchema),
                    allowedLoopbackPorts: Type.Optional(
                        Type.Array(Type.Integer({ minimum: 1, maximum: 65_535 }), {
                            maxItems: MAX_CONFIG_ARRAY_ITEMS,
                        }),
                    ),
                    allowedPorts: Type.Optional(
                        Type.Array(Type.Integer({ minimum: 1, maximum: 65_535 }), {
                            maxItems: MAX_CONFIG_ARRAY_ITEMS,
                        }),
                    ),
                    deniedDomains: Type.Optional(boundedStringArraySchema),
                },
                { additionalProperties: false },
            ),
        ),
        observation: Type.Object(
            {
                historyDump: Type.Boolean(),
                logLevel: logLevelSchema,
                logs: Type.Boolean(),
                traces: Type.Boolean(),
                tracesEndpoint: traceEndpointSchema,
            },
            { additionalProperties: false },
        ),
        p2p: Type.Object(
            {
                direct: Type.Object(
                    { listen: Type.Optional(configStringSchema) },
                    {
                        additionalProperties: false,
                    },
                ),
                enableDirect: Type.Boolean(),
                enableIroh: Type.Boolean(),
                enableSsh: Type.Boolean(),
                exposeApi: Type.Boolean(),
                iroh: Type.Object(
                    { relayUrl: Type.Optional(configStringSchema) },
                    {
                        additionalProperties: false,
                    },
                ),
                name: configStringSchema,
                primaryId: Type.Optional(configStringSchema),
                role: Type.Union([Type.Literal("primary"), Type.Literal("secondary")]),
            },
            { additionalProperties: false },
        ),
        permissions: Type.Object(
            {
                protectedPaths: projectRelativePathsSchema,
            },
            { additionalProperties: false },
        ),
        presence: Type.Object(
            {
                current: Type.Optional(configStringSchema),
                fallback: Type.Optional(configStringSchema),
                states: Type.Record(
                    configStringSchema,
                    Type.Object(
                        {
                            answerWaitMs: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
                            emoji: Type.Optional(configStringSchema),
                            prompt: Type.Optional(configStringSchema),
                            title: Type.Optional(configStringSchema),
                        },
                        { additionalProperties: false },
                    ),
                    { maxProperties: MAX_CONFIG_TABLE_ENTRIES },
                ),
                until: Type.Optional(Type.Integer()),
            },
            { additionalProperties: false },
        ),
        providerDefaultEnable: Type.Boolean(),
        providers: Type.Record(configStringSchema, providerSchema, {
            maxProperties: MAX_PROVIDER_COUNT,
        }),
        settings: Type.Object(
            {
                compactCompletedTurns: Type.Boolean(),
                completionChime: Type.Boolean(),
                daemonHeapSnapshots: Type.Boolean(),
                durableGlobalEventQueue: Type.Boolean(),
                happyIntegration: Type.Boolean(),
                inferenceMaxRetries: Type.Integer({
                    minimum: 0,
                    maximum: MAX_INFERENCE_MAX_RETRIES,
                }),
                showReasoning: Type.Boolean(),
                showUsage: Type.Boolean(),
                toolResultRetentionDays: Type.Integer({
                    minimum: 0,
                    maximum: MAX_TOOL_RESULT_RETENTION_DAYS,
                }),
            },
            { additionalProperties: false },
        ),
        theme: Type.Object(
            {
                accent: configStringSchema,
                brand: configStringSchema,
                error: configStringSchema,
                primary: configStringSchema,
                secondary: configStringSchema,
                success: configStringSchema,
                warning: configStringSchema,
            },
            { additionalProperties: false },
        ),
        workspace: Type.Object(
            {
                /**
                 * A workspace copied from a project without Git is the person's own folder rather
                 * than a checkout Git can rebuild, so archiving leaves it behind by default. A
                 * worktree is rebuildable, so archiving removes it by default.
                 */
                keepCopiesOnArchive: Type.Boolean(),
                keepWorktreesOnArchive: Type.Boolean(),
                protectedSync: projectRelativePathsSchema,
                setupCommands: boundedStringArraySchema,
                sync: projectRelativePathsSchema,
            },
            { additionalProperties: false },
        ),
    },
    { additionalProperties: false },
);

const pathSchemaSet = Type.Object(
    {
        agentHome: pathSchema,
        agentLockPath: pathSchema,
        appletsPath: pathSchema,
        autoAgentLockPath: pathSchema,
        autoDatabasePath: pathSchema,
        configHome: pathSchema,
        databasePath: pathSchema,
        generatedPath: pathSchema,
        globalConfigPath: pathSchema,
        happyHome: pathSchema,
        historyDumpHome: pathSchema,
        instructionsPath: pathSchema,
        localConfigPath: pathSchema,
        logPath: pathSchema,
        observationHome: pathSchema,
        publicHome: pathSchema,
        runtimeConfigPath: pathSchema,
        securityPath: pathSchema,
        socketPath: pathSchema,
        tokenPath: pathSchema,
        workletsPath: pathSchema,
    },
    { additionalProperties: false },
);
const sourceSchema = Type.Object(
    {
        exists: Type.Boolean(),
        path: pathSchema,
        unknownSettings: Type.Array(configStringSchema, { maxItems: MAX_UNKNOWN_SETTINGS }),
        unknownSettingsTruncated: Type.Boolean(),
        values: Type.Record(configStringSchema, Type.Unknown(), {
            maxProperties: MAX_CONFIG_TABLE_ENTRIES,
        }),
    },
    { additionalProperties: false },
);
const provenanceSchema = Type.Record(
    configStringSchema,
    Type.Union([
        Type.Literal("default"),
        Type.Literal("global"),
        Type.Literal("local"),
        Type.Literal("runtime"),
    ]),
    { maxProperties: MAX_PROVENANCE_ENTRIES },
);

export const happyAgentConfigurationInputSchema = Type.Union([
    Type.String({
        minLength: 1,
        maxLength: MAX_PATH_LENGTH,
        pattern: "^[^\\u0000]+$",
    }),
    Type.Undefined(),
]);
export type HappyAgentConfigurationInput = Static<typeof happyAgentConfigurationInputSchema>;

export const happyAgentConfigurationPathsSchema = pathSchemaSet;
export const happyAgentConfigValuesSchema = resolvedValuesSchema;
export const happyAgentConfigSourceSchema = sourceSchema;
export const happyAgentConfigurationSchema = Type.Object(
    {
        paths: happyAgentConfigurationPathsSchema,
        provenance: provenanceSchema,
        sources: Type.Object(
            {
                global: sourceSchema,
                local: sourceSchema,
                runtime: sourceSchema,
            },
            { additionalProperties: false },
        ),
        values: happyAgentConfigValuesSchema,
    },
    { additionalProperties: false },
);

export type HappyAgentConfigurationPaths = Readonly<
    Static<typeof happyAgentConfigurationPathsSchema>
>;
export type HappyAgentConfigValues = Readonly<Static<typeof happyAgentConfigValuesSchema>>;
export type HappyAgentConfigSource = Readonly<Static<typeof happyAgentConfigSourceSchema>>;
export type HappyAgentConfiguration = Readonly<Static<typeof happyAgentConfigurationSchema>>;
type PartialValues = Static<typeof partialValuesSchema>;
type ConfigSourceKind = "global" | "local" | "runtime";

const DEFAULT_VALUES: HappyAgentConfigValues = {
    defaults: {
        modelId: "openai/gpt-5.6-sol",
        permissionMode: "auto",
    },
    features: {
        crossWorkspace: false,
        workflows: true,
        workspaces: true,
    },
    mcpServers: {},
    observation: {
        historyDump: false,
        logLevel: "info",
        logs: true,
        traces: false,
        tracesEndpoint: "http://127.0.0.1:4318/v1/traces",
    },
    p2p: {
        direct: {},
        enableDirect: false,
        enableIroh: true,
        enableSsh: false,
        exposeApi: false,
        iroh: {},
        name: "happy",
        role: "primary",
    },
    permissions: { protectedPaths: [] },
    presence: { states: {} },
    providerDefaultEnable: true,
    providers: {
        bedrock: { enabled: true, type: "bedrock" },
        claude: { enabled: true, type: "claude" },
        codex: { enabled: true, type: "codex" },
        grok: { enabled: true, type: "grok" },
    },
    settings: {
        compactCompletedTurns: false,
        completionChime: false,
        daemonHeapSnapshots: false,
        durableGlobalEventQueue: false,
        happyIntegration: true,
        inferenceMaxRetries: 10,
        showReasoning: false,
        showUsage: false,
        toolResultRetentionDays: 7,
    },
    theme: {
        accent: "cyan",
        brand: "ansi:202",
        error: "red",
        primary: "default",
        secondary: "dim",
        success: "green",
        warning: "yellow",
    },
    workspace: {
        keepCopiesOnArchive: true,
        keepWorktreesOnArchive: false,
        protectedSync: [],
        setupCommands: [],
        sync: [],
    },
};

/**
 * The resolved Happy Agent configuration and filesystem layout. It is loaded before the agent
 * system and passed to every module that needs configuration.
 */
export class ConfigModule implements AgentModule {
    readonly name = "config";
    readonly configuration: HappyAgentConfiguration;

    private constructor(configuration: HappyAgentConfiguration) {
        this.configuration = configuration;
    }

    /** Apply configured root instructions through the normal pre-inference hook. */
    readonly instructions = async (): Promise<string> =>
        this.configuration.values.defaults.instructions ?? "";

    static async load(input?: HappyAgentConfigurationInput): Promise<ConfigModule> {
        const paths = derivePaths(input);
        const [global, local, runtime] = await Promise.all([
            readConfigSource(paths.globalConfigPath, "global"),
            readProjectConfigSource(paths.localConfigPath),
            readConfigSource(paths.runtimeConfigPath, "runtime"),
        ]);
        const localValues = withoutProjectMachineSettings(local.values);
        const values = mergeValues(global.values, localValues, runtime.values);
        const configuration = {
            paths,
            provenance: calculateProvenance(global.values, localValues, runtime.values),
            sources: {
                global: sourceSnapshot(global),
                local: sourceSnapshot(local),
                runtime: sourceSnapshot(runtime),
            },
            values,
        };
        if (!Value.Check(happyAgentConfigurationSchema, configuration)) {
            throw new Error("The Happy Agent configuration is invalid.");
        }
        return new ConfigModule(deepFreeze(configuration));
    }
}

export async function loadHappyAgentConfiguration(
    input?: HappyAgentConfigurationInput,
): Promise<HappyAgentConfiguration> {
    return (await ConfigModule.load(input)).configuration;
}

export function parseHappyAgentConfigToml(source: string): {
    readonly unknownSettings: readonly string[];
    readonly unknownSettingsTruncated: boolean;
    readonly values: PartialValues;
} {
    if (Buffer.byteLength(source, "utf8") > MAX_CONFIG_FILE_BYTES) {
        throw new Error(`Configuration exceeds the ${MAX_CONFIG_FILE_BYTES}-byte limit.`);
    }
    const table = parse(source);
    if (!isTable(table)) throw new Error("The Happy Agent configuration must be a TOML table.");
    assertTableSize(table, "configuration");
    const unknownSettings: string[] = [];
    let unknownSettingsTruncated = false;
    const recordUnknown = (path: string) => {
        if (unknownSettings.length >= MAX_UNKNOWN_SETTINGS) {
            unknownSettingsTruncated = true;
            return;
        }
        if (path.length > MAX_CONFIG_STRING_LENGTH) {
            unknownSettings.push(path.slice(0, MAX_CONFIG_STRING_LENGTH));
            unknownSettingsTruncated = true;
            return;
        }
        unknownSettings.push(path);
    };
    const knownTopLevel = new Set([
        "defaults",
        "docker",
        "features",
        "mcp_servers",
        "network",
        "observation",
        "p2p",
        "permissions",
        "presence",
        "providers",
        "settings",
        "theme",
        "workspace",
    ]);
    for (const key of Object.keys(table)) {
        if (!knownTopLevel.has(key)) recordUnknown(key);
    }
    const defaults = readDefaults(table.defaults, recordUnknown);
    const providers = readProviders(table.providers, recordUnknown);
    const settings = readSettings(table.settings, recordUnknown);
    const features = readFeatures(table.features, recordUnknown);
    const workspace = readWorkspace(table.workspace, recordUnknown);
    const docker = readDocker(table.docker, recordUnknown);
    const mcpServers = readMcpServers(table.mcp_servers, recordUnknown);
    const network = readNetwork(table.network, recordUnknown);
    const observation = readObservation(table.observation, recordUnknown);
    const p2p = readP2p(table.p2p, recordUnknown);
    const permissions = readPermissions(table.permissions, recordUnknown);
    const presence = readPresence(table.presence, recordUnknown);
    const theme = readTheme(table.theme, recordUnknown);
    const providerDefaultEnable =
        table.providers !== undefined && isTable(table.providers)
            ? readBoolean(table.providers, "default_enable", "providers.default_enable")
            : undefined;
    const values = {
        ...(defaults === undefined ? {} : { defaults }),
        ...(features === undefined ? {} : { features }),
        ...(docker === undefined ? {} : { docker }),
        ...(mcpServers === undefined ? {} : { mcp_servers: mcpServers }),
        ...(network === undefined ? {} : { network }),
        ...(observation === undefined ? {} : { observation }),
        ...(p2p === undefined ? {} : { p2p }),
        ...(permissions === undefined ? {} : { permissions }),
        ...(presence === undefined ? {} : { presence }),
        ...(providerDefaultEnable === undefined
            ? {}
            : { provider_default_enable: providerDefaultEnable }),
        ...(providers === undefined ? {} : { providers }),
        ...(settings === undefined ? {} : { settings }),
        ...(theme === undefined ? {} : { theme }),
        ...(workspace === undefined ? {} : { workspace }),
    };
    if (!Value.Check(partialValuesSchema, values)) {
        throw new Error("The Happy Agent configuration contains an invalid value.");
    }
    return { unknownSettings, unknownSettingsTruncated, values };
}

interface ReadSource {
    readonly exists: boolean;
    readonly path: string;
    readonly unknownSettings: readonly string[];
    readonly unknownSettingsTruncated: boolean;
    readonly values: PartialValues;
}

function sourceSnapshot(source: ReadSource): HappyAgentConfigSource {
    return {
        exists: source.exists,
        path: source.path,
        unknownSettings: [...source.unknownSettings],
        unknownSettingsTruncated: source.unknownSettingsTruncated,
        values: normalizeSourceValues(source.values),
    };
}

function normalizeSourceValues(values: PartialValues): Record<string, unknown> {
    return {
        ...(values.docker === undefined ? {} : { docker: normalizeDocker(values.docker) }),
        ...(values.defaults === undefined ? {} : { defaults: normalizeDefaults(values.defaults) }),
        ...(values.features === undefined ? {} : { features: normalizeFeatures(values.features) }),
        ...(values.mcp_servers === undefined
            ? {}
            : { mcpServers: normalizeMcpServers(values.mcp_servers) }),
        ...(values.network === undefined ? {} : { network: normalizeNetwork(values.network) }),
        ...(values.p2p === undefined ? {} : { p2p: normalizeP2p(values.p2p) }),
        ...(values.permissions === undefined
            ? {}
            : { permissions: { protectedPaths: values.permissions.protected_paths ?? [] } }),
        ...(values.presence === undefined ? {} : { presence: normalizePresence(values.presence) }),
        ...(values.provider_default_enable === undefined
            ? {}
            : { providerDefaultEnable: values.provider_default_enable }),
        ...(values.providers === undefined
            ? {}
            : {
                  providers: Object.fromEntries(
                      Object.entries(values.providers).map(([id, provider]) => [
                          id,
                          normalizeProvider(id, provider as Record<string, unknown>),
                      ]),
                  ),
              }),
        ...(values.settings === undefined ? {} : { settings: normalizeSettings(values.settings) }),
        ...(values.theme === undefined ? {} : { theme: values.theme }),
        ...(values.workspace === undefined
            ? {}
            : { workspace: normalizeWorkspace(values.workspace) }),
    };
}

async function readProjectConfigSource(rigTomlPath: string): Promise<ReadSource> {
    const preferred = await readConfigSource(rigTomlPath, "local");
    if (preferred.exists) return preferred;
    return readConfigSource(join(dirname(rigTomlPath), "happy.toml"), "local");
}

async function readConfigSource(path: string, _kind: ConfigSourceKind): Promise<ReadSource> {
    let file: Awaited<ReturnType<typeof open>> | undefined;
    try {
        file = await open(path, "r");
        const bytes = Buffer.allocUnsafe(MAX_CONFIG_FILE_BYTES + 1);
        const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
        if (bytesRead > MAX_CONFIG_FILE_BYTES) {
            throw new Error(`Configuration exceeds the ${MAX_CONFIG_FILE_BYTES}-byte limit.`);
        }
        const parsed = parseHappyAgentConfigToml(bytes.subarray(0, bytesRead).toString("utf8"));
        return { exists: true, path, ...parsed };
    } catch (error) {
        if (isMissingFile(error)) {
            return {
                exists: false,
                path,
                unknownSettings: [],
                unknownSettingsTruncated: false,
                values: {},
            };
        }
        if (error instanceof Error) {
            throw new Error(`Could not read Happy Agent configuration '${path}'.`, {
                cause: error,
            });
        }
        throw error;
    } finally {
        await file?.close().catch(() => undefined);
    }
}

function derivePaths(input: HappyAgentConfigurationInput): HappyAgentConfigurationPaths {
    if (!Value.Check(happyAgentConfigurationInputSchema, input)) {
        throw new Error("The Happy root path must be a non-empty path.");
    }
    const happyHome = resolveHappyHome(input);
    const publicHome = join(dirname(happyHome), "Happy");
    const agentHome = join(happyHome, "agent");
    const configHome = join(publicHome, "Config");
    // What the agent records about itself stays in the private root beside its database, because
    // logs and a verbatim history dump say everything the conversation said.
    const observationHome = join(agentHome, "observation");
    const paths = {
        agentHome,
        agentLockPath: join(agentHome, "agent.lock"),
        appletsPath: join(publicHome, "Applets"),
        // The automatic permission reviewer keeps its own review-only agent system in a separate
        // database and single-owner lock beside, never on top of, the main agent's own files, so
        // the reviewer's state shares nothing with the agent it reviews.
        autoAgentLockPath: join(agentHome, "auto-agent.lock"),
        autoDatabasePath: join(agentHome, "auto-agent.sqlite"),
        configHome,
        databasePath: join(agentHome, "agent.sqlite"),
        generatedPath: join(publicHome, "Generated"),
        globalConfigPath: join(configHome, "happy.toml"),
        happyHome,
        historyDumpHome: join(observationHome, "history"),
        instructionsPath: join(configHome, "AGENTS.md"),
        localConfigPath: join(process.cwd(), "rig.toml"),
        logPath: join(observationHome, "agent.log"),
        observationHome,
        publicHome,
        runtimeConfigPath: join(agentHome, "runtime.toml"),
        securityPath: join(configHome, "SECURITY.md"),
        socketPath: join(agentHome, "server.sock"),
        tokenPath: join(agentHome, "token"),
        workletsPath: join(publicHome, "Worklets"),
    };
    if (!Value.Check(happyAgentConfigurationPathsSchema, paths)) {
        throw new Error("The Happy Agent filesystem layout is invalid.");
    }
    return Object.freeze(paths);
}

function resolveHappyHome(input: HappyAgentConfigurationInput): string {
    if (input === undefined) return resolve(homedir(), ".happy");
    if (input === "~") return resolve(homedir());
    if (input.startsWith("~/")) return resolve(homedir(), input.slice(2));
    return resolve(input);
}

function mergeValues(...partials: readonly PartialValues[]): HappyAgentConfigValues {
    const merged = structuredClone(DEFAULT_VALUES) as MutableResolvedValues;
    const explicitProviderEnabled = new Set<string>();
    for (const partial of partials) {
        if (partial.docker !== undefined) merged.docker = normalizeDocker(partial.docker);
        if (partial.defaults !== undefined) {
            const defaults = normalizeDefaults(partial.defaults);
            Object.assign(merged.defaults, defaults);
            if (partial.defaults.service_tier === "default") delete merged.defaults.serviceTier;
        }
        if (partial.features !== undefined)
            Object.assign(merged.features, normalizeFeatures(partial.features));
        if (partial.mcp_servers !== undefined) {
            Object.assign(merged.mcpServers, normalizeMcpServers(partial.mcp_servers));
        }
        if (partial.network !== undefined) merged.network = normalizeNetwork(partial.network);
        if (partial.observation !== undefined)
            Object.assign(merged.observation, normalizeObservation(partial.observation));
        if (partial.permissions?.protected_paths !== undefined) {
            merged.permissions.protectedPaths = [
                ...new Set([
                    ...merged.permissions.protectedPaths,
                    ...partial.permissions.protected_paths,
                ]),
            ];
        }
        if (partial.p2p !== undefined) merged.p2p = mergeP2p(merged.p2p, partial.p2p);
        if (partial.presence !== undefined)
            merged.presence = mergePresence(merged.presence, partial.presence);
        if (partial.provider_default_enable !== undefined) {
            merged.providerDefaultEnable = partial.provider_default_enable;
        }
        if (partial.providers !== undefined) {
            for (const [id, provider] of Object.entries(partial.providers)) {
                const normalized = normalizeProvider(id, provider as Record<string, unknown>);
                merged.providers[id] = {
                    ...normalized,
                    enabled: provider.enabled ?? merged.providerDefaultEnable,
                } as Static<typeof providerSchema>;
                if (provider.enabled === undefined) explicitProviderEnabled.delete(id);
                else explicitProviderEnabled.add(id);
            }
        }
        if (partial.settings !== undefined) {
            Object.assign(merged.settings, normalizeSettings(partial.settings));
        }
        if (partial.theme !== undefined) Object.assign(merged.theme, partial.theme);
        if (partial.workspace !== undefined) {
            Object.assign(merged.workspace, normalizeWorkspace(partial.workspace));
        }
    }
    for (const [id, provider] of Object.entries(merged.providers)) {
        if (!explicitProviderEnabled.has(id)) {
            provider.enabled = merged.providerDefaultEnable;
        }
    }
    if (!Value.Check(happyAgentConfigValuesSchema, merged)) {
        throw new Error("The merged Happy Agent configuration is invalid.");
    }
    return deepFreeze(merged);
}

type MutableResolvedValues = {
    -readonly [Key in keyof Static<typeof resolvedValuesSchema>]: Static<
        typeof resolvedValuesSchema
    >[Key];
};

function normalizeDefaults(value: PartialValues["defaults"]): Record<string, unknown> {
    if (value === undefined) return {};
    return {
        ...(value.effort === undefined ? {} : { effort: value.effort }),
        ...(value.instructions === undefined ? {} : { instructions: value.instructions }),
        ...(value.model === undefined ? {} : { modelId: value.model }),
        ...(value.permission_mode === undefined ? {} : { permissionMode: value.permission_mode }),
        ...(value.provider === undefined ? {} : { providerId: value.provider }),
        ...(value.service_tier === undefined || value.service_tier === "default"
            ? {}
            : { serviceTier: value.service_tier }),
    };
}

function normalizeFeatures(value: NonNullable<PartialValues["features"]>): Record<string, unknown> {
    return {
        ...(value.cross_workspace === undefined ? {} : { crossWorkspace: value.cross_workspace }),
        ...(value.workflows === undefined ? {} : { workflows: value.workflows }),
        ...(value.workspaces === undefined ? {} : { workspaces: value.workspaces }),
    };
}

function normalizeSettings(value: NonNullable<PartialValues["settings"]>): Record<string, unknown> {
    return {
        ...(value.compact_completed_turns === undefined
            ? {}
            : { compactCompletedTurns: value.compact_completed_turns }),
        ...(value.completion_chime === undefined
            ? {}
            : { completionChime: value.completion_chime }),
        ...(value.daemon_heap_snapshots === undefined
            ? {}
            : { daemonHeapSnapshots: value.daemon_heap_snapshots }),
        ...(value.durable_global_event_queue === undefined
            ? {}
            : { durableGlobalEventQueue: value.durable_global_event_queue }),
        ...(value.happy_integration === undefined
            ? {}
            : { happyIntegration: value.happy_integration }),
        ...(value.inference_max_retries === undefined
            ? {}
            : { inferenceMaxRetries: value.inference_max_retries }),
        ...(value.show_reasoning === undefined ? {} : { showReasoning: value.show_reasoning }),
        ...(value.show_usage === undefined ? {} : { showUsage: value.show_usage }),
        ...(value.tool_result_retention_days === undefined
            ? {}
            : { toolResultRetentionDays: value.tool_result_retention_days }),
    };
}

function normalizeWorkspace(
    value: NonNullable<PartialValues["workspace"]>,
): Record<string, unknown> {
    return {
        ...(value.keep_copies_on_archive === undefined
            ? {}
            : { keepCopiesOnArchive: value.keep_copies_on_archive }),
        ...(value.keep_worktrees_on_archive === undefined
            ? {}
            : { keepWorktreesOnArchive: value.keep_worktrees_on_archive }),
        ...(value.protected_sync === undefined ? {} : { protectedSync: value.protected_sync }),
        ...(value.setup_commands === undefined ? {} : { setupCommands: value.setup_commands }),
        ...(value.sync === undefined ? {} : { sync: value.sync }),
    };
}

function normalizeDocker(
    value: NonNullable<PartialValues["docker"]>,
): NonNullable<Static<typeof resolvedValuesSchema>["docker"]> {
    if ((value.container === undefined) === (value.image === undefined)) {
        throw new Error('docker must configure exactly one of "container" or "image".');
    }
    if (value.workdir !== undefined && !value.workdir.startsWith("/")) {
        throw new Error("docker.workdir must be an absolute container path.");
    }
    return {
        ...(value.container === undefined ? {} : { container: value.container }),
        ...(value.env === undefined ? {} : { environment: value.env }),
        ...(value.image === undefined ? {} : { image: value.image }),
        ...(value.mounts === undefined
            ? {}
            : {
                  mounts: value.mounts.map((mount) => ({
                      ...(mount.read_only === undefined ? {} : { readOnly: mount.read_only }),
                      source: mount.source,
                      target: mount.target,
                  })),
              }),
        ...(value.name === undefined ? {} : { name: value.name }),
        ...(value.socket_path === undefined ? {} : { socketPath: value.socket_path }),
        workingDirectory: value.workdir ?? "/workspace",
    };
}

function normalizeNetwork(value: NonNullable<PartialValues["network"]>): Record<string, unknown> {
    return {
        ...(value.allow_local_binding === undefined
            ? {}
            : { allowLocalBinding: value.allow_local_binding }),
        ...(value.allowed_domains === undefined ? {} : { allowedDomains: value.allowed_domains }),
        ...(value.allowed_loopback_ports === undefined
            ? {}
            : { allowedLoopbackPorts: value.allowed_loopback_ports }),
        ...(value.allowed_ports === undefined ? {} : { allowedPorts: value.allowed_ports }),
        ...(value.denied_domains === undefined ? {} : { deniedDomains: value.denied_domains }),
    };
}

function normalizeObservation(
    value: NonNullable<PartialValues["observation"]>,
): Record<string, unknown> {
    return {
        ...(value.history_dump === undefined ? {} : { historyDump: value.history_dump }),
        ...(value.log_level === undefined ? {} : { logLevel: value.log_level }),
        ...(value.logs === undefined ? {} : { logs: value.logs }),
        ...(value.traces === undefined ? {} : { traces: value.traces }),
        ...(value.traces_endpoint === undefined ? {} : { tracesEndpoint: value.traces_endpoint }),
    };
}

function normalizeP2p(value: NonNullable<PartialValues["p2p"]>): Record<string, unknown> {
    return {
        ...(value.enable_direct === undefined ? {} : { enableDirect: value.enable_direct }),
        ...(value.enable_iroh === undefined ? {} : { enableIroh: value.enable_iroh }),
        ...(value.enable_ssh === undefined ? {} : { enableSsh: value.enable_ssh }),
        ...(value.expose_api === undefined ? {} : { exposeApi: value.expose_api }),
        ...(value.name === undefined ? {} : { name: value.name }),
        ...(value.primary_id === undefined ? {} : { primaryId: value.primary_id }),
        ...(value.role === undefined ? {} : { role: value.role }),
        ...(value.direct === undefined
            ? {}
            : {
                  direct: {
                      ...(value.direct.listen === undefined ? {} : { listen: value.direct.listen }),
                  },
              }),
        ...(value.iroh === undefined
            ? {}
            : {
                  iroh: {
                      ...(value.iroh.relay_url === undefined
                          ? {}
                          : { relayUrl: value.iroh.relay_url }),
                  },
              }),
    };
}

function normalizePresence(value: NonNullable<PartialValues["presence"]>): Record<string, unknown> {
    return {
        ...(value.current === undefined ? {} : { current: value.current }),
        ...(value.fallback === undefined ? {} : { fallback: value.fallback }),
        ...(value.until === undefined ? {} : { until: parseDateValue(value.until) }),
        ...(value.states === undefined
            ? {}
            : {
                  states: Object.fromEntries(
                      Object.entries(value.states).map(([id, state]) => [
                          id,
                          {
                              ...(state.answer_wait === undefined
                                  ? {}
                                  : { answerWaitMs: parseAnswerWait(state.answer_wait) }),
                              ...(state.emoji === undefined ? {} : { emoji: state.emoji }),
                              ...(state.prompt === undefined ? {} : { prompt: state.prompt }),
                              ...(state.title === undefined ? {} : { title: state.title }),
                          },
                      ]),
                  ),
              }),
    };
}

function normalizeMcpServers(
    value: NonNullable<PartialValues["mcp_servers"]>,
): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [name, server] of Object.entries(value)) {
        const startupTimeoutMs =
            server.startup_timeout_sec === undefined
                ? undefined
                : mcpTimeoutMilliseconds(server.startup_timeout_sec, `${name}.startup_timeout_sec`);
        const toolTimeoutMs =
            server.tool_timeout_sec === undefined
                ? undefined
                : mcpTimeoutMilliseconds(server.tool_timeout_sec, `${name}.tool_timeout_sec`);
        if ((server.command === undefined) === (server.url === undefined)) {
            throw new Error(`MCP server "${name}" must configure either command or url.`);
        }
        if (server.command !== undefined) {
            result[name] = {
                ...(server.args === undefined ? {} : { args: server.args }),
                ...(server.cwd === undefined ? {} : { cwd: server.cwd }),
                ...(server.disabled_tools === undefined
                    ? {}
                    : { disabledTools: server.disabled_tools }),
                ...(server.enabled === undefined ? {} : { enabled: server.enabled }),
                ...(server.enabled_tools === undefined
                    ? {}
                    : { enabledTools: server.enabled_tools }),
                ...(server.env === undefined ? {} : { env: server.env }),
                ...(startupTimeoutMs === undefined ? {} : { startupTimeoutMs }),
                ...(toolTimeoutMs === undefined ? {} : { toolTimeoutMs }),
                command: server.command,
                transport: "stdio",
            };
        } else {
            result[name] = {
                ...(server.bearer_token_env_var === undefined
                    ? {}
                    : { bearerTokenEnvVar: server.bearer_token_env_var }),
                ...(server.disabled_tools === undefined
                    ? {}
                    : { disabledTools: server.disabled_tools }),
                ...(server.enabled === undefined ? {} : { enabled: server.enabled }),
                ...(server.enabled_tools === undefined
                    ? {}
                    : { enabledTools: server.enabled_tools }),
                ...(server.http_headers === undefined ? {} : { headers: server.http_headers }),
                ...(server.oauth_client_id_env_var === undefined
                    ? {}
                    : { oauthClientIdEnvVar: server.oauth_client_id_env_var }),
                ...(server.oauth_client_secret_env_var === undefined
                    ? {}
                    : { oauthClientSecretEnvVar: server.oauth_client_secret_env_var }),
                ...(server.oauth_scopes === undefined ? {} : { oauthScopes: server.oauth_scopes }),
                ...(startupTimeoutMs === undefined ? {} : { startupTimeoutMs }),
                ...(toolTimeoutMs === undefined ? {} : { toolTimeoutMs }),
                transport: "http",
                url: server.url,
            };
        }
    }
    return result;
}

function mcpTimeoutMilliseconds(seconds: number, name: string): number {
    const milliseconds = seconds * 1_000;
    if (!Number.isSafeInteger(milliseconds) || milliseconds < 1) {
        throw new Error(`MCP ${name} must resolve to a whole millisecond.`);
    }
    return milliseconds;
}

function mergeP2p(
    base: MutableResolvedValues["p2p"],
    value: NonNullable<PartialValues["p2p"]>,
): MutableResolvedValues["p2p"] {
    const { primaryId: basePrimaryId, ...baseWithoutPrimaryId } = base;
    const primaryId =
        value.role === "primary"
            ? {}
            : value.primary_id === undefined
              ? basePrimaryId === undefined
                  ? {}
                  : { primaryId: basePrimaryId }
              : { primaryId: value.primary_id };
    return {
        ...baseWithoutPrimaryId,
        ...(value.enable_direct === undefined ? {} : { enableDirect: value.enable_direct }),
        ...(value.enable_iroh === undefined ? {} : { enableIroh: value.enable_iroh }),
        ...(value.enable_ssh === undefined ? {} : { enableSsh: value.enable_ssh }),
        ...(value.expose_api === undefined ? {} : { exposeApi: value.expose_api }),
        ...(value.name === undefined ? {} : { name: value.name }),
        ...(value.role === undefined ? {} : { role: value.role }),
        ...primaryId,
        direct: {
            ...base.direct,
            ...(value.direct?.listen === undefined ? {} : { listen: value.direct.listen }),
        },
        iroh: {
            ...base.iroh,
            ...(value.iroh === undefined ? {} : { relayUrl: value.iroh.relay_url }),
        },
    };
}

function mergePresence(
    base: MutableResolvedValues["presence"],
    value: NonNullable<PartialValues["presence"]>,
): MutableResolvedValues["presence"] {
    const baseWithoutTransient =
        value.current === undefined
            ? base
            : (({ fallback: _fallback, until: _until, ...rest }) => rest)(base);
    return {
        ...baseWithoutTransient,
        ...(value.current === undefined ? {} : { current: value.current }),
        ...(value.fallback === undefined ? {} : { fallback: value.fallback }),
        ...(value.until === undefined ? {} : { until: parseDateValue(value.until) }),
        states: {
            ...base.states,
            ...Object.fromEntries(
                Object.entries(value.states ?? {}).map(([id, state]) => [
                    id,
                    {
                        ...base.states[id],
                        ...(state.answer_wait === undefined
                            ? {}
                            : { answerWaitMs: parseAnswerWait(state.answer_wait) }),
                        ...(state.emoji === undefined ? {} : { emoji: state.emoji }),
                        ...(state.prompt === undefined ? {} : { prompt: state.prompt }),
                        ...(state.title === undefined ? {} : { title: state.title }),
                    },
                ]),
            ),
        },
    };
}

function normalizeProvider(id: string, value: Record<string, unknown>): Record<string, unknown> {
    const inferred = inferProviderType(id, value["type"]);
    switch (inferred) {
        case "bedrock":
            return {
                ...normalizeProviderCommon(value),
                ...(value["bearer_token"] === undefined
                    ? {}
                    : { bearerToken: value["bearer_token"] }),
                ...(value["bearer_token_env_var"] === undefined
                    ? {}
                    : { bearerTokenEnvVar: value["bearer_token_env_var"] }),
                ...(value["model_overrides"] === undefined
                    ? {}
                    : { modelOverrides: value["model_overrides"] }),
                ...(value["region"] === undefined ? {} : { region: value["region"] }),
                ...(value["search_model"] === undefined
                    ? {}
                    : { searchModelId: value["search_model"] }),
                type: inferred,
            };
        case "claude":
            return {
                ...normalizeProviderCommon(value),
                ...(value["api_key"] === undefined ? {} : { apiKey: value["api_key"] }),
                ...(value["auth_token"] === undefined ? {} : { authToken: value["auth_token"] }),
                ...(value["config_dir"] === undefined ? {} : { configDir: value["config_dir"] }),
                ...(value["executable"] === undefined ? {} : { executable: value["executable"] }),
                ...(value["oauth_token"] === undefined ? {} : { oauthToken: value["oauth_token"] }),
                type: inferred,
            };
        case "codex":
            return {
                ...normalizeProviderCommon(value),
                ...(value["api_key"] === undefined ? {} : { apiKey: value["api_key"] }),
                ...(value["auth_file"] === undefined ? {} : { authFile: value["auth_file"] }),
                ...(value["base_url"] === undefined ? {} : { baseUrl: value["base_url"] }),
                ...(value["transport"] === undefined ? {} : { transport: value["transport"] }),
                type: inferred,
            };
        case "grok":
            return {
                ...normalizeProviderCommon(value),
                ...(value["api_key"] === undefined ? {} : { apiKey: value["api_key"] }),
                ...(value["auth_file"] === undefined ? {} : { authFile: value["auth_file"] }),
                ...(value["base_url"] === undefined ? {} : { baseUrl: value["base_url"] }),
                type: inferred,
            };
    }
}

function normalizeProviderCommon(value: Record<string, unknown>): Record<string, unknown> {
    return {
        ...(value["credential_isolation"] === true ? { credentialIsolation: true } : {}),
        ...(value["enabled"] === undefined ? {} : { enabled: value["enabled"] }),
        ...(value["exclude_models"] === undefined
            ? {}
            : { excludeModels: value["exclude_models"] }),
        ...(value["include_models"] === undefined
            ? {}
            : { includeModels: value["include_models"] }),
        ...(value["p2p_share"] === undefined ? {} : { p2pShare: value["p2p_share"] }),
    };
}

function inferProviderType(id: string, type: unknown): "bedrock" | "claude" | "codex" | "grok" {
    const builtIn = ["bedrock", "claude", "codex", "grok"].includes(id)
        ? (id as "bedrock" | "claude" | "codex" | "grok")
        : undefined;
    if (type !== undefined && type !== builtIn && builtIn !== undefined) {
        throw new Error(`Built-in provider "${id}" must use type "${builtIn}".`);
    }
    if (type !== undefined && !["bedrock", "claude", "codex", "grok"].includes(String(type))) {
        throw new Error(`Provider "${id}" has an unsupported type.`);
    }
    const inferred = (type ?? builtIn) as "bedrock" | "claude" | "codex" | "grok" | undefined;
    if (inferred === undefined) {
        throw new Error(
            `Provider "${id}" must set type to "codex", "claude", "grok", or "bedrock".`,
        );
    }
    return inferred;
}

function withoutProjectMachineSettings(values: PartialValues): PartialValues {
    const {
        docker: _docker,
        // Observation is dropped along with the other machine settings, and for a sharper reason:
        // a checked-in project file that turns tracing on and names its own endpoint would send
        // this machine's traces wherever the repository asked.
        observation: _observation,
        p2p: _p2p,
        provider_default_enable: _providerDefaultEnable,
        providers: _providers,
        defaults,
        settings,
        ...rest
    } = values;
    const { permission_mode: _permissionMode, ...projectDefaults } = defaults ?? {};
    const {
        daemon_heap_snapshots: _daemonHeapSnapshots,
        durable_global_event_queue: _durableGlobalEventQueue,
        happy_integration: _happyIntegration,
        inference_max_retries: _inferenceMaxRetries,
        tool_result_retention_days: _toolResultRetentionDays,
        ...projectSettings
    } = settings ?? {};
    return {
        ...rest,
        ...(Object.keys(projectDefaults).length === 0 ? {} : { defaults: projectDefaults }),
        ...(Object.keys(projectSettings).length === 0 ? {} : { settings: projectSettings }),
    };
}

function calculateProvenance(...sources: readonly PartialValues[]): Record<string, string> {
    const result: Record<string, string> = {};
    const names: readonly ConfigSourceKind[] = ["global", "local", "runtime"];
    const sectionNames: Readonly<Record<string, string>> = {
        mcp_servers: "mcpServers",
        provider_default_enable: "providerDefaultEnable",
    };
    const fieldNames: Readonly<Record<string, Readonly<Record<string, string>>>> = {
        defaults: {
            effort: "effort",
            instructions: "instructions",
            model: "modelId",
            permission_mode: "permissionMode",
            provider: "providerId",
            service_tier: "serviceTier",
        },
        features: {
            cross_workspace: "crossWorkspace",
            workflows: "workflows",
            workspaces: "workspaces",
        },
        observation: {
            history_dump: "historyDump",
            log_level: "logLevel",
            logs: "logs",
            traces: "traces",
            traces_endpoint: "tracesEndpoint",
        },
        settings: {
            compact_completed_turns: "compactCompletedTurns",
            completion_chime: "completionChime",
            daemon_heap_snapshots: "daemonHeapSnapshots",
            durable_global_event_queue: "durableGlobalEventQueue",
            happy_integration: "happyIntegration",
            inference_max_retries: "inferenceMaxRetries",
            show_reasoning: "showReasoning",
            show_usage: "showUsage",
            tool_result_retention_days: "toolResultRetentionDays",
        },
        workspace: {
            keep_copies_on_archive: "keepCopiesOnArchive",
            keep_worktrees_on_archive: "keepWorktreesOnArchive",
            protected_sync: "protectedSync",
            setup_commands: "setupCommands",
            sync: "sync",
        },
    };
    for (let index = 0; index < sources.length; index += 1) {
        const source = sources[index];
        const name = names[index];
        if (source === undefined || name === undefined) continue;
        for (const section of Object.keys(source)) {
            const normalizedSection = sectionNames[section] ?? section;
            result[normalizedSection] = name;
            if (
                section === "defaults" ||
                section === "settings" ||
                section === "features" ||
                section === "observation" ||
                section === "workspace"
            ) {
                for (const key of Object.keys(source[section] ?? {})) {
                    result[`${normalizedSection}.${fieldNames[section]?.[key] ?? key}`] = name;
                }
            }
        }
    }
    return result;
}

function readDefaults(
    value: TomlValue | undefined,
    unknown: (path: string) => void,
): PartialValues["defaults"] {
    return readTableValues(
        value,
        "defaults",
        unknown,
        ["effort", "instructions", "model", "permission_mode", "provider", "service_tier"],
        defaultsInputSchema,
    ) as PartialValues["defaults"];
}

function readSettings(
    value: TomlValue | undefined,
    unknown: (path: string) => void,
): PartialValues["settings"] {
    return readTableValues(
        value,
        "settings",
        unknown,
        [
            "compact_completed_turns",
            "completion_chime",
            "daemon_heap_snapshots",
            "durable_global_event_queue",
            "happy_integration",
            "inference_max_retries",
            "show_reasoning",
            "show_usage",
            "tool_result_retention_days",
        ],
        settingsInputSchema,
    ) as PartialValues["settings"];
}

function readFeatures(
    value: TomlValue | undefined,
    unknown: (path: string) => void,
): PartialValues["features"] {
    return readTableValues(
        value,
        "features",
        unknown,
        ["cross_workspace", "workflows", "workspaces"],
        Type.Object(
            {
                cross_workspace: Type.Optional(Type.Boolean()),
                workflows: Type.Optional(Type.Boolean()),
                workspaces: Type.Optional(Type.Boolean()),
            },
            { additionalProperties: false },
        ),
    ) as PartialValues["features"];
}

function readWorkspace(
    value: TomlValue | undefined,
    unknown: (path: string) => void,
): PartialValues["workspace"] {
    return readTableValues(
        value,
        "workspace",
        unknown,
        [
            "keep_copies_on_archive",
            "keep_worktrees_on_archive",
            "protected_sync",
            "setup_commands",
            "sync",
        ],
        Type.Object(
            {
                keep_copies_on_archive: Type.Optional(Type.Boolean()),
                keep_worktrees_on_archive: Type.Optional(Type.Boolean()),
                protected_sync: Type.Optional(projectRelativePathsSchema),
                setup_commands: Type.Optional(boundedStringArraySchema),
                sync: Type.Optional(projectRelativePathsSchema),
            },
            { additionalProperties: false },
        ),
    ) as PartialValues["workspace"];
}

function readTheme(
    value: TomlValue | undefined,
    unknown: (path: string) => void,
): PartialValues["theme"] {
    return readTableValues(
        value,
        "theme",
        unknown,
        ["accent", "brand", "error", "primary", "secondary", "success", "warning"],
        Type.Object(
            {
                accent: Type.Optional(configStringSchema),
                brand: Type.Optional(configStringSchema),
                error: Type.Optional(configStringSchema),
                primary: Type.Optional(configStringSchema),
                secondary: Type.Optional(configStringSchema),
                success: Type.Optional(configStringSchema),
                warning: Type.Optional(configStringSchema),
            },
            { additionalProperties: false },
        ),
    ) as PartialValues["theme"];
}

function readDocker(
    value: TomlValue | undefined,
    unknown: (path: string) => void,
): PartialValues["docker"] {
    const docker = readTableValues(
        value,
        "docker",
        unknown,
        Object.keys(dockerInputSchema.properties),
        dockerInputSchema,
    ) as PartialValues["docker"];
    if (docker === undefined) return undefined;
    const mounts = docker.mounts?.map((mount, index) => {
        const raw = mount as Record<string, unknown>;
        for (const key of Object.keys(raw)) {
            if (!["read_only", "source", "target"].includes(key)) {
                unknown(`docker.mounts[${index}].${key}`);
            }
        }
        return {
            ...(raw.read_only === undefined ? {} : { read_only: raw.read_only }),
            source: raw.source,
            target: raw.target,
        };
    });
    const sanitized = {
        ...docker,
        ...(mounts === undefined ? {} : { mounts }),
    } as NonNullable<PartialValues["docker"]>;
    if ((sanitized.container === undefined) === (sanitized.image === undefined)) {
        throw new Error('docker must configure exactly one of "container" or "image".');
    }
    if (sanitized.workdir !== undefined && !sanitized.workdir.startsWith("/")) {
        throw new Error("docker.workdir must be an absolute container path.");
    }
    if (
        sanitized.container !== undefined &&
        (sanitized.env !== undefined ||
            sanitized.mounts !== undefined ||
            sanitized.name !== undefined)
    ) {
        throw new Error("docker env, mounts, and name can only be used when docker.image is set.");
    }
    for (const [index, mount] of (sanitized.mounts ?? []).entries()) {
        if (!mount.target.startsWith("/")) {
            throw new Error(`docker.mounts[${index}].target must be an absolute container path.`);
        }
    }
    if (!Value.Check(dockerInputSchema, sanitized)) {
        throw new Error("docker contains an invalid value.");
    }
    return sanitized;
}

function readNetwork(
    value: TomlValue | undefined,
    unknown: (path: string) => void,
): PartialValues["network"] {
    return readTableValues(
        value,
        "network",
        unknown,
        [
            "allow_local_binding",
            "allowed_domains",
            "allowed_loopback_ports",
            "allowed_ports",
            "denied_domains",
        ],
        partialValuesSchema.properties.network!,
    ) as PartialValues["network"];
}

function readObservation(
    value: TomlValue | undefined,
    unknown: (path: string) => void,
): PartialValues["observation"] {
    return readTableValues(
        value,
        "observation",
        unknown,
        ["history_dump", "log_level", "logs", "traces", "traces_endpoint"],
        partialValuesSchema.properties.observation!,
    ) as PartialValues["observation"];
}

function readP2p(
    value: TomlValue | undefined,
    unknown: (path: string) => void,
): PartialValues["p2p"] {
    const p2p = readTableValues(
        value,
        "p2p",
        unknown,
        [
            "direct",
            "enable_direct",
            "enable_iroh",
            "enable_ssh",
            "expose_api",
            "iroh",
            "name",
            "primary_id",
            "role",
        ],
        partialValuesSchema.properties.p2p!,
    ) as PartialValues["p2p"];
    if (p2p === undefined) return undefined;
    const direct = p2p.direct;
    if (direct !== undefined) {
        const raw = direct as Record<string, unknown>;
        for (const key of Object.keys(raw)) {
            if (key !== "listen") unknown(`p2p.direct.${key}`);
        }
        if (raw.listen !== undefined && typeof raw.listen !== "string") {
            throw new Error("p2p.direct.listen must be a string.");
        }
        p2p.direct = raw.listen === undefined ? {} : { listen: raw.listen };
    }
    const iroh = p2p.iroh;
    if (iroh !== undefined) {
        const raw = iroh as Record<string, unknown>;
        for (const key of Object.keys(raw)) {
            if (key !== "relay_url") unknown(`p2p.iroh.${key}`);
        }
        if (raw.relay_url !== undefined && typeof raw.relay_url !== "string") {
            throw new Error("p2p.iroh.relay_url must be a string.");
        }
        p2p.iroh = raw.relay_url === undefined ? {} : { relay_url: raw.relay_url };
    }
    if (p2p.name !== undefined && (p2p.name.length === 0 || p2p.name.length > 128)) {
        throw new Error("p2p.name must be 1–128 printable characters.");
    }
    if (p2p.iroh?.relay_url !== undefined && !/^https?:\/\//u.test(p2p.iroh.relay_url)) {
        throw new Error("p2p.iroh.relay_url must be an HTTP or HTTPS URL.");
    }
    if (
        (p2p.role === "secondary" &&
            (p2p.primary_id === undefined || !Value.Check(p2pInstanceIdSchema, p2p.primary_id))) ||
        (p2p.role !== "secondary" && p2p.primary_id !== undefined)
    ) {
        throw new Error("p2p.primary_id requires p2p.role to be secondary.");
    }
    return p2p;
}

function readPermissions(
    value: TomlValue | undefined,
    unknown: (path: string) => void,
): PartialValues["permissions"] {
    return readTableValues(
        value,
        "permissions",
        unknown,
        ["protected_paths"],
        partialValuesSchema.properties.permissions!,
    ) as PartialValues["permissions"];
}

function readPresence(
    value: TomlValue | undefined,
    unknown: (path: string) => void,
): PartialValues["presence"] {
    if (value === undefined) return undefined;
    if (!isTable(value)) throw new Error("presence must be a TOML table.");
    assertTableSize(value, "presence");
    const known = new Set(["current", "fallback", "states", "until"]);
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
        if (!known.has(key)) {
            unknown(`presence.${key}`);
            continue;
        }
        if (key === "until" && item instanceof TomlDate) {
            result.until = item.getTime();
            continue;
        }
        if (key !== "states") {
            result[key] = item;
            continue;
        }
        if (!isTable(item)) throw new Error("presence.states must be a TOML table.");
        assertTableSize(item, "presence.states");
        const states: Record<string, unknown> = {};
        for (const [id, state] of Object.entries(item)) {
            if (!/^[a-z0-9_-]+$/u.test(id)) {
                throw new Error(
                    `Presence "${id}" must be named with lowercase letters, numbers, dashes, or underscores.`,
                );
            }
            if (!isTable(state)) throw new Error(`presence.states.${id} must be a TOML table.`);
            assertTableSize(state, `presence.states.${id}`);
            const stateResult: Record<string, unknown> = {};
            for (const [stateKey, stateValue] of Object.entries(state)) {
                if (!["answer_wait", "emoji", "prompt", "title"].includes(stateKey)) {
                    unknown(`presence.states.${id}.${stateKey}`);
                    continue;
                }
                stateResult[stateKey] = stateValue;
            }
            states[id] = stateResult;
        }
        result.states = states;
    }
    if (!Value.Check(partialValuesSchema.properties.presence!, result)) {
        throw new Error("presence contains an invalid value.");
    }
    return result as PartialValues["presence"];
}

function readMcpServers(
    value: TomlValue | undefined,
    unknown: (path: string) => void,
): PartialValues["mcp_servers"] {
    if (value === undefined) return undefined;
    if (!isTable(value)) throw new Error("mcp_servers must be a TOML table.");
    assertTableSize(value, "mcp_servers");
    const result: Record<string, unknown> = {};
    const known = [
        "args",
        "bearer_token_env_var",
        "command",
        "cwd",
        "disabled_tools",
        "enabled",
        "enabled_tools",
        "env",
        "http_headers",
        "oauth_client_id_env_var",
        "oauth_client_secret_env_var",
        "oauth_scopes",
        "startup_timeout_sec",
        "tool_timeout_sec",
        "transport",
        "url",
    ];
    const entrySchema = Type.Object(
        {
            args: Type.Optional(boundedStringArraySchema),
            bearer_token_env_var: Type.Optional(configStringSchema),
            command: Type.Optional(
                Type.String({ minLength: 1, maxLength: MAX_CONFIG_STRING_LENGTH }),
            ),
            cwd: Type.Optional(pathSchema),
            disabled_tools: Type.Optional(boundedStringArraySchema),
            enabled: Type.Optional(Type.Boolean()),
            enabled_tools: Type.Optional(boundedStringArraySchema),
            env: Type.Optional(
                Type.Record(configStringSchema, configStringSchema, {
                    maxProperties: MAX_CONFIG_TABLE_ENTRIES,
                }),
            ),
            http_headers: Type.Optional(
                Type.Record(configStringSchema, configStringSchema, {
                    maxProperties: MAX_CONFIG_TABLE_ENTRIES,
                }),
            ),
            oauth_client_id_env_var: Type.Optional(configStringSchema),
            oauth_client_secret_env_var: Type.Optional(configStringSchema),
            oauth_scopes: Type.Optional(boundedStringArraySchema),
            startup_timeout_sec: Type.Optional(
                Type.Number({ exclusiveMinimum: 0, maximum: MAX_MCP_TIMEOUT_SECONDS }),
            ),
            tool_timeout_sec: Type.Optional(
                Type.Number({ exclusiveMinimum: 0, maximum: MAX_MCP_TIMEOUT_SECONDS }),
            ),
            transport: Type.Optional(Type.Literal("http")),
            url: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_CONFIG_STRING_LENGTH })),
        },
        { additionalProperties: false },
    );
    for (const [name, server] of Object.entries(value)) {
        if (!isTable(server)) throw new Error(`mcp_servers.${name} must be a TOML table.`);
        result[name] = readTableValues(server, `mcp_servers.${name}`, unknown, known, entrySchema);
        const parsed = result[name] as Record<string, unknown>;
        const command = parsed["command"];
        const url = parsed["url"];
        if ((command === undefined) === (url === undefined)) {
            throw new Error(`MCP server "${name}" must configure either command or url.`);
        }
        if (
            url !== undefined &&
            parsed["transport"] !== undefined &&
            parsed["transport"] !== "http"
        ) {
            throw new Error(`MCP server "${name}" uses unsupported transport.`);
        }
    }
    if (!Value.Check(mcpInputSchema, result)) {
        throw new Error("mcp_servers contains an invalid server.");
    }
    return result as PartialValues["mcp_servers"];
}

function readProviders(
    value: TomlValue | undefined,
    unknown: (path: string) => void,
): PartialValues["providers"] {
    if (value === undefined) return undefined;
    if (!isTable(value)) throw new Error("providers must be a TOML table.");
    assertTableSize(value, "providers");
    if (Object.keys(value).filter((id) => id !== "default_enable").length > MAX_PROVIDER_COUNT) {
        throw new Error(`providers must contain at most ${MAX_PROVIDER_COUNT} providers.`);
    }
    const result: Record<string, unknown> = {};
    for (const [id, providerValue] of Object.entries(value)) {
        if (id === "default_enable") continue;
        if (!isTable(providerValue)) throw new Error(`providers.${id} must be a TOML table.`);
        assertTableSize(providerValue, `providers.${id}`);
        const type =
            providerValue.type ??
            (["bedrock", "claude", "codex", "grok"].includes(id) ? id : undefined);
        const schema =
            type === "bedrock"
                ? providerInputSchemas.bedrock
                : type === "claude"
                  ? providerInputSchemas.claude
                  : type === "codex"
                    ? providerInputSchemas.codex
                    : type === "grok"
                      ? providerInputSchemas.grok
                      : undefined;
        if (schema === undefined) {
            throw new Error(
                `Provider "${id}" must set type to "codex", "claude", "grok", or "bedrock".`,
            );
        }
        if (["bedrock", "claude", "codex", "grok"].includes(id) && type !== id) {
            throw new Error(`Built-in provider "${id}" must use type "${id}".`);
        }
        const allowed = Object.keys(schema.properties);
        const parsed = readTableValues(providerValue, `providers.${id}`, unknown, allowed, schema);
        if (parsed !== undefined && providerValue.model_overrides !== undefined) {
            parsed.model_overrides = readModelOverrides(
                providerValue.model_overrides,
                `providers.${id}.model_overrides`,
                unknown,
            );
        }
        result[id] = parsed;
    }
    if (!Value.Check(providerMapInputSchema, result)) {
        throw new Error("providers contains an invalid provider.");
    }
    return result as PartialValues["providers"];
}

function readModelOverrides(
    value: TomlValue,
    name: string,
    unknown: (path: string) => void,
): Record<string, unknown> {
    if (!isTable(value)) throw new Error(`${name} must be a TOML table.`);
    assertTableSize(value, name);
    const schema = Type.Object(
        {
            endpoint: Type.Optional(configStringSchema),
            region: Type.Optional(configStringSchema),
            transport: Type.Optional(Type.Union([Type.Literal("mantle"), Type.Literal("runtime")])),
        },
        { additionalProperties: false },
    );
    const result: Record<string, unknown> = {};
    for (const [model, override] of Object.entries(value)) {
        if (!isTable(override)) throw new Error(`${name}.${model} must be a TOML table.`);
        assertTableSize(override, `${name}.${model}`);
        result[model] = readTableValues(
            override,
            `${name}.${model}`,
            unknown,
            ["endpoint", "region", "transport"],
            schema,
        );
    }
    return result;
}

function readTableValues(
    value: TomlValue | undefined,
    name: string,
    unknown: (path: string) => void,
    knownKeys: readonly string[],
    schema: TSchema,
): Record<string, unknown> | undefined {
    if (value === undefined) return undefined;
    if (!isTable(value)) throw new Error(`${name} must be a TOML table.`);
    assertTableSize(value, name);
    const result: Record<string, unknown> = {};
    const known = new Set(knownKeys);
    for (const [key, item] of Object.entries(value)) {
        if (!known.has(key)) {
            unknown(`${name}.${key}`);
            continue;
        }
        result[key] = item;
    }
    if (!Value.Check(schema, result)) {
        throw new Error(`${name} contains an invalid value.`);
    }
    return result;
}

function assertTableSize(table: TomlTable, name: string): void {
    if (Object.keys(table).length > MAX_CONFIG_TABLE_ENTRIES) {
        throw new Error(`${name} must contain at most ${MAX_CONFIG_TABLE_ENTRIES} properties.`);
    }
}

function readBoolean(table: TomlTable, key: string, path: string): boolean | undefined {
    const value = table[key];
    if (value === undefined) return undefined;
    if (typeof value !== "boolean") throw new Error(`${path} must be a boolean.`);
    return value;
}

function parseAnswerWait(value: string | null): number | null {
    if (value === null) return null;
    const normalized = value.trim().toLowerCase();
    if (normalized === "unlimited" || normalized === "forever") return null;
    if (normalized === "none" || normalized === "never") return 0;
    const match =
        /^([0-9]+(?:\.[0-9]+)?)\s*(milliseconds?|ms|seconds?|s|minutes?|m|hours?|h|days?|d)$/u.exec(
            normalized,
        );
    if (match === null) throw new Error("presence.states.*.answer_wait must be a duration.");
    const amount = match[1];
    const unitName = match[2];
    if (amount === undefined || unitName === undefined) {
        throw new Error("presence.states.*.answer_wait must be a duration.");
    }
    const unit =
        unitName.startsWith("ms") || unitName.startsWith("millisecond")
            ? 1
            : unitName.startsWith("s")
              ? 1_000
              : unitName.startsWith("m")
                ? 60_000
                : unitName.startsWith("h")
                  ? 3_600_000
                  : 86_400_000;
    return Math.round(Number(amount) * unit);
}

function parseDateValue(value: string | number): number {
    if (typeof value === "number") {
        if (!Number.isSafeInteger(value)) throw new Error("presence.until must be a date.");
        return value;
    }
    const time = Date.parse(value);
    if (!Number.isFinite(time)) throw new Error("presence.until must be a date.");
    return time;
}

function isTable(value: TomlValue | undefined): value is TomlTable {
    return (
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value) &&
        !(value instanceof TomlDate)
    );
}

function isMissingFile(error: unknown): boolean {
    return (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error.code === "ENOENT" || error.code === "ENOTDIR")
    );
}

function deepFreeze<T>(value: T): T {
    if (value === null || typeof value !== "object") return value;
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    return value;
}
