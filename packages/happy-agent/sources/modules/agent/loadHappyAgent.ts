import { randomUUID } from "node:crypto";
import { chmod, mkdir } from "node:fs/promises";
import { resolve } from "node:path";

import { createId } from "@paralleldrive/cuid2";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
    AgentStorage,
    AgentSystemLocal,
    agentDatabaseRows,
    agentDatabaseRun,
    currentAgentEnvironment,
    type Agent,
    type AgentConfig,
    type AgentDatabase,
    type AgentModel,
    type AgentModule,
    type AgentProviders,
    type AnyAgentTool,
} from "@slopus/happy-agent-base";
import { hostComputeProvider } from "@slopus/happy-agent-compute";
import {
    AppletModule,
    ConfigModule,
    CollaborationModule,
    ComputeModule,
    EventsModule,
    GoalModule,
    HappyModule,
    HistoryModule,
    ImageGenerationModule,
    McpModule,
    ModelSwitchModule,
    ObservationModule,
    PermissionsModule,
    PresenceModule,
    ProjectsModule,
    SchedulingModule,
    SearchModule,
    SecretsModule,
    SkillsModule,
    SlotsModule,
    SystemPromptModule,
    TasksModule,
    UsageModule,
    UserInputModule,
    WorkflowsModule,
    WorkletsModule,
    WorkspacesModule,
    agentComputeConfigSchema,
    createComputeModules,
    happyAgentConfigurationSchema,
    type CollaborationBroker,
    type EventsModuleOptions,
    type HappyHost,
    type ImageGenerator,
    type McpHost,
    type PermissionReviewer,
    type SchedulingScheduler,
    type SearchBackend,
    type SecretResolver,
    type SlotPublisher,
    type SlotScopeResolver,
    type UserInputBroker,
    type WorkflowRuntime,
    type WorkletRuntime,
    type WorkspaceHost,
    type PresenceModuleOptions,
} from "@slopus/happy-agent-modules";
import { sql } from "drizzle-orm";
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import type { Context } from "@steve.kite/stdlib";

import { checkModuleToolParameters } from "./checkModuleToolParameters.js";
import { openHappyAgentDatabase } from "./HappyAgentDatabase.js";
import { acquireHappyAgentStorageLock } from "./HappyAgentStorageLock.js";
import { readGlobalInstructions } from "./readGlobalInstructions.js";
import type { HappyAgentConfiguration } from "@slopus/happy-agent-modules";
import { ConversationModule } from "../conversations/ConversationModule.js";
import type { EffectiveAgentSelection } from "../../vanillaHappyAgentConfiguration.js";

const providerSchema = Type.String({ minLength: 1, maxLength: 256 });
const loaderProviderInputSchema = Type.Object(
    { provider: providerSchema },
    { additionalProperties: false },
);
const rootAgentIdSchema = Type.String({
    minLength: 1,
    maxLength: 128,
    pattern: "^[a-z][a-z0-9]+$",
});
const modelSchema = Type.Object(
    {
        defaultEffort: Type.Union([
            Type.Literal("off"),
            Type.Literal("low"),
            Type.Literal("medium"),
            Type.Literal("high"),
            Type.Literal("xhigh"),
            Type.Literal("max"),
            Type.Literal("ultra"),
        ]),
        effortLevels: Type.Array(
            Type.Union([
                Type.Literal("off"),
                Type.Literal("low"),
                Type.Literal("medium"),
                Type.Literal("high"),
                Type.Literal("xhigh"),
                Type.Literal("max"),
                Type.Literal("ultra"),
            ]),
            { minItems: 1 },
        ),
        id: Type.String({ minLength: 1, maxLength: 256 }),
        name: Type.String({ minLength: 1, maxLength: 256 }),
        providerId: Type.String({ minLength: 1, maxLength: 256 }),
        serviceTiers: Type.Optional(Type.Array(Type.Literal("priority"), { minItems: 1 })),
    },
    { additionalProperties: false },
);
const effectiveSelectionSchema = Type.Object(
    {
        effort: Type.String({ minLength: 1, maxLength: 32 }),
        model: Type.String({ minLength: 1, maxLength: 256 }),
        permissionMode: Type.Union([
            Type.Literal("read_only"),
            Type.Literal("workspace_write"),
            Type.Literal("auto"),
            Type.Literal("full_access"),
        ]),
        provider: Type.String({ minLength: 1, maxLength: 256 }),
        serviceTier: Type.Optional(Type.Literal("priority")),
    },
    { additionalProperties: false },
);
export interface HappyAgentIntegrations {
    readonly collaboration: CollaborationBroker;
    readonly happy: HappyHost;
    readonly imageGeneration: ImageGenerator;
    readonly mcp: McpHost;
    readonly scheduling: SchedulingScheduler;
    readonly search: SearchBackend;
    readonly slots: {
        readonly publisher: SlotPublisher;
        readonly scopeResolver: SlotScopeResolver;
    };
    readonly userInput: UserInputBroker;
    readonly workflows: WorkflowRuntime;
    readonly worklets: WorkletRuntime;
    readonly permissionReviewer?: PermissionReviewer;
    readonly secretResolver?: SecretResolver;
    readonly workspaceHost?: WorkspaceHost;
}

export interface LoadHappyAgentOptions {
    /** The resolved, shared Happy Agent filesystem layout. */
    readonly configuration: HappyAgentConfiguration;
    readonly configModule: ConfigModule;
    /** What the host already started observing with, so the agent records into the same files. */
    readonly observation: ObservationModule;
    readonly integrations: HappyAgentIntegrations;
    readonly providers: AgentProviders;
    readonly provider: string;
    readonly models: readonly AgentModel[];
    readonly effectiveSelection: EffectiveAgentSelection;
    readonly config?: AgentConfig;
    readonly events?: EventsModuleOptions;
}

export interface HappyAgentModuleCollection {
    readonly config: ConfigModule;
    readonly applets: AppletModule;
    readonly collaboration: CollaborationModule;
    readonly conversations: ConversationModule;
    readonly compute: ComputeModule;
    readonly events: EventsModule;
    readonly goal: GoalModule;
    readonly happy: HappyModule;
    readonly history: HistoryModule;
    readonly imageGeneration: ImageGenerationModule;
    readonly mcp: McpModule;
    readonly modelSwitch: ModelSwitchModule;
    readonly observation: ObservationModule;
    readonly permissions: PermissionsModule;
    readonly presence: PresenceModule;
    readonly projects: ProjectsModule;
    readonly scheduling: SchedulingModule;
    readonly search: SearchModule;
    readonly secrets: SecretsModule;
    readonly skills: SkillsModule;
    readonly slots: SlotsModule;
    readonly systemPrompt: SystemPromptModule;
    readonly tasks: TasksModule;
    readonly usage: UsageModule;
    readonly userInput: UserInputModule;
    readonly workflows: WorkflowsModule;
    readonly worklets: WorkletsModule;
    readonly workspaces: WorkspacesModule;
}

export interface LoadedHappyAgent {
    readonly agent: Agent<AnyAgentTool, LibSQLDatabase>;
    readonly configuration: HappyAgentConfiguration;
    readonly configModule: ConfigModule;
    readonly effectiveSelection: EffectiveAgentSelection;
    readonly compute: ComputeModule;
    readonly database: LibSQLDatabase;
    readonly modules: HappyAgentModuleCollection;
    readonly installation: {
        readonly epoch: string;
        readonly schemaVersion: number;
    };
    readonly storage: AgentStorage<LibSQLDatabase>;
    readonly system: AgentSystemLocal<LibSQLDatabase>;
    close(ctx: Context): Promise<void>;
}

/**
 * Load one durable Happy agent and every standard module from one resolved configuration.
 *
 * The loader owns the SQLite connection, hard store lock, host compute, AgentStorage, and
 * AgentSystem lifetime. External services remain explicit integrations and are validated by the
 * modules that consume them.
 */
export async function loadHappyAgent(
    ctx: Context,
    options: LoadHappyAgentOptions,
): Promise<LoadedHappyAgent> {
    assertLoaderInput(options);
    if (options.providers.typeOf(options.provider) === null) {
        throw new Error(`The default provider '${options.provider}' is not registered.`);
    }
    const { configuration } = options;
    await prepareHomes(configuration);

    const databasePath = configuration.paths.databasePath;
    const opened = await openHappyAgentDatabase(databasePath);
    let modules: HappyAgentModuleCollection | undefined;
    let system: AgentSystemLocal<LibSQLDatabase> | undefined;
    let loaderIdentity:
        | {
              readonly epoch: string;
              readonly rootAgentId: string;
              readonly schemaVersion: number;
          }
        | undefined;
    try {
        await chmod(databasePath, 0o600);
        const storage = new AgentStorage({
            acquireLock: async () =>
                await acquireHappyAgentStorageLock(configuration.paths.agentLockPath),
            database: opened.database,
        });
        modules = createModules(
            options.configModule,
            options.observation,
            options.integrations,
            options.models,
            options.events,
        );
        const loaderStateModule = createLoaderStateModule((identity) => {
            loaderIdentity = identity;
        });
        const orderedModules: AgentModule<AnyAgentTool, LibSQLDatabase>[] = [
            modules.config,
            modules.observation,
            modules.systemPrompt,
            modules.conversations,
            modules.history,
            modules.modelSwitch,
            modules.permissions,
            modules.presence,
            modules.goal,
            modules.tasks,
            modules.usage,
            modules.projects,
            modules.workspaces,
            modules.secrets,
            modules.slots,
            modules.collaboration,
            modules.scheduling,
            modules.userInput,
            modules.workflows,
            modules.worklets,
            modules.applets,
            modules.imageGeneration,
            modules.search,
            modules.happy,
            modules.mcp,
            modules.skills,
            modules.compute,
            modules.events,
            loaderStateModule,
        ].map(checkModuleToolParameters);
        system = await AgentSystemLocal.create(ctx, storage, {
            models: options.models,
            modules: orderedModules,
            provider: options.provider,
            providers: options.providers,
        }).catch((error: unknown) => {
            throw new Error("Creating the Agent System failed.", { cause: error });
        });
        const identity = loaderIdentity;
        if (identity === undefined) {
            throw new Error("The Happy Agent identity was not initialized before restoration.");
        }
        const agentId = identity.rootAgentId;
        const existing = await system.config(ctx, agentId);
        const config = rootAgentConfig(options.config, configuration.paths.publicHome);
        if (existing !== undefined)
            assertExistingRootAgentConfig(existing, configuration.paths.publicHome);
        const agent =
            existing === undefined
                ? await system.create(ctx, config, { id: agentId }).catch((error: unknown) => {
                      throw new Error("Creating the root Happy Agent failed.", { cause: error });
                  })
                : await system.resolve(ctx, agentId);

        let closed = false;
        return {
            agent,
            configuration,
            configModule: options.configModule,
            effectiveSelection: options.effectiveSelection,
            compute: modules.compute,
            database: opened.database,
            modules,
            installation: {
                epoch: identity.epoch,
                schemaVersion: identity.schemaVersion,
            },
            storage,
            system,
            close: async (closeCtx) => {
                if (closed) return;
                closed = true;
                const failures: unknown[] = [];
                await system!.close(closeCtx).catch((error: unknown) => failures.push(error));
                await modules!.compute
                    .dispose(closeCtx)
                    .catch((error: unknown) => failures.push(error));
                try {
                    opened.close();
                } catch (error) {
                    failures.push(error);
                }
                if (failures.length > 0) {
                    throw new AggregateError(failures, "The Happy agent did not close cleanly.");
                }
            },
        };
    } catch (error) {
        const failures: unknown[] = [error];
        if (system !== undefined) {
            await system.close(ctx).catch((closeError: unknown) => failures.push(closeError));
        }
        if (modules !== undefined) {
            await modules.compute
                .dispose(ctx)
                .catch((closeError: unknown) => failures.push(closeError));
        }
        try {
            opened.close();
        } catch (closeError) {
            failures.push(closeError);
        }
        if (failures.length === 1) throw error;
        throw new AggregateError(failures, "Loading and cleaning up the Happy agent failed.");
    }
}

function createModules(
    configModule: ConfigModule,
    observation: ObservationModule,
    integrations: HappyAgentIntegrations,
    models: readonly AgentModel[],
    events: EventsModuleOptions | undefined,
): HappyAgentModuleCollection {
    const { configuration } = configModule;
    // The dump listens to the committed archive rather than recording alongside it, so what a
    // person reads in the file is exactly what the agent durably remembers.
    const history = new HistoryModule({ onAppend: observation.recordHistory });
    const protectedProjectFiles = [
        ...new Set([
            "AGENTS.md",
            "AGENTS_SECURITY.md",
            ...configuration.values.permissions.protectedPaths,
            ...configuration.values.workspace.protectedSync,
        ]),
    ];
    const compute = createComputeModules({
        provider: {
            id: "host",
            create: async (ctx, config) =>
                await hostComputeProvider.create(ctx, {
                    ...config,
                    hostPolicy: {
                        privateDirectories: [configuration.paths.agentHome],
                        protectedProjectFiles,
                    },
                }),
        },
    });
    const initialPresence = configuredInitialPresence(configuration.values.presence);
    const presenceOptions = {
        catalog: configuredPresenceCatalog(configuration.values.presence),
        ...(initialPresence === undefined ? {} : { initialState: initialPresence }),
    } as unknown as ConstructorParameters<typeof PresenceModule>[0];
    const presence = new PresenceModule(presenceOptions);
    return {
        config: configModule,
        observation,
        applets: new AppletModule({ rootDirectory: configuration.paths.appletsPath }),
        collaboration: new CollaborationModule({
            broker: integrations.collaboration,
            modelCatalog: {
                availableModels: models.map((model) => ({
                    defaultEffort: model.defaultEffort,
                    effortLevels: [...model.effortLevels],
                    id: model.id,
                    name: model.name,
                    providerId: model.providerId,
                    ...(model.serviceTiers === undefined
                        ? {}
                        : { serviceTiers: [...model.serviceTiers] }),
                })),
                disabledProviders: Object.entries(configuration.values.providers).flatMap(
                    ([providerId, provider]): {
                        id: string;
                        reason: "not_enabled" | "no_models";
                    }[] => {
                        if (provider.enabled === false) {
                            return [{ id: providerId, reason: "not_enabled" as const }];
                        }
                        if (!models.some((model) => model.providerId === providerId)) {
                            return [{ id: providerId, reason: "no_models" as const }];
                        }
                        return [];
                    },
                ),
            },
        }),
        conversations: new ConversationModule({ defaultCwd: configuration.paths.publicHome }),
        compute: compute.computeModule,
        events: new EventsModule(events),
        goal: new GoalModule({}),
        happy: new HappyModule({ host: integrations.happy }),
        history,
        imageGeneration: new ImageGenerationModule({
            generator: integrations.imageGeneration,
            outputDirectory: configuration.paths.generatedPath,
        }),
        mcp: new McpModule({ host: integrations.mcp }),
        modelSwitch: new ModelSwitchModule({ history }),
        permissions: new PermissionsModule({
            ...(integrations.permissionReviewer === undefined
                ? {}
                : { reviewer: integrations.permissionReviewer }),
            killAllSessions: async (_ctx, agentId) => {
                for (const session of compute.computeModule.runningCommands(agentId)) {
                    await compute.computeModule.stopCommand(agentId, session.sessionId);
                }
            },
        }),
        presence,
        projects: new ProjectsModule({}),
        scheduling: new SchedulingModule({ scheduler: integrations.scheduling }),
        search: new SearchModule({ backend: integrations.search }),
        secrets: new SecretsModule(
            integrations.secretResolver === undefined
                ? {}
                : { resolveForHost: integrations.secretResolver },
        ),
        skills: compute.skillsModule,
        slots: new SlotsModule({
            publisher: integrations.slots.publisher,
            scopeResolver: integrations.slots.scopeResolver,
        }),
        systemPrompt: new SystemPromptModule({
            availableModels: models.map((model) => ({
                id: model.id,
                name: model.name,
                providerId: model.providerId,
            })),
            compute: {
                resolve: async (ctx, agentId) => await compute.computeModule.resolve(ctx, agentId),
            },
            globalInstructions: {
                path: configuration.paths.instructionsPath,
                read: readGlobalInstructions,
            },
        }),
        tasks: new TasksModule({}),
        usage: new UsageModule({}),
        userInput: new UserInputModule({
            broker: integrations.userInput,
            presence: presence.userInputPolicy,
        }),
        workflows: new WorkflowsModule({
            enabled: configuration.values.features.workflows,
            runtime: integrations.workflows,
        }),
        worklets: new WorkletsModule({
            installRoot: configuration.paths.workletsPath,
            runtime: integrations.worklets,
        }),
        workspaces: new WorkspacesModule({
            enabled: configuration.values.features.workspaces,
            ...(integrations.workspaceHost === undefined
                ? {}
                : { host: integrations.workspaceHost }),
        }),
    };
}

function rootAgentConfig(config: AgentConfig | undefined, publicHome: string): AgentConfig {
    const environment = config?.environment;
    if (environment !== undefined && resolve(environment.workingDirectory) !== publicHome) {
        throw new Error("The root agent working directory must match its public Happy home.");
    }
    const configuredCompute = config?.modules?.compute;
    if (configuredCompute !== undefined) {
        if (
            !Value.Check(agentComputeConfigSchema, configuredCompute) ||
            resolve((configuredCompute as { readonly cwd: string }).cwd) !== publicHome ||
            ((configuredCompute as { readonly providerId?: string }).providerId ?? "host") !==
                "host"
        ) {
            throw new Error("The root agent compute configuration must use its public Happy home.");
        }
    }
    return {
        ...config,
        environment: environment ?? {
            ...currentAgentEnvironment(),
            workingDirectory: publicHome,
        },
        modules: {
            ...config?.modules,
            compute: { cwd: publicHome, providerId: "host" },
        },
    };
}

type ConfiguredPresenceDefinition = NonNullable<PresenceModuleOptions["catalog"]>[number];
type ConfiguredPresenceState = {
    readonly presenceId: string;
    readonly fallbackPresenceId?: string;
    readonly expiresAt?: number;
};
const BUILT_IN_PRESENCE_DEFINITIONS: readonly ConfiguredPresenceDefinition[] = [
    {
        id: "online",
        status: "online",
        title: "Online",
        emoji: "🟢",
        prompt: "The user is at the keyboard and can answer questions right away.",
        answerWaitMs: null,
    },
    {
        id: "away",
        status: "away",
        title: "Away",
        emoji: "🌙",
        prompt: "The user is away and cannot be reached.",
        answerWaitMs: 0,
    },
    {
        id: "offline",
        status: "offline",
        title: "Offline",
        emoji: "⚫",
        prompt: "The user is offline and cannot be reached.",
        answerWaitMs: 0,
    },
    {
        id: "dnd",
        status: "dnd",
        title: "Do not disturb",
        emoji: "🔕",
        prompt: "The user has asked not to be disturbed.",
        answerWaitMs: 0,
    },
];

function configuredPresenceCatalog(
    presence: HappyAgentConfiguration["values"]["presence"],
): ConfiguredPresenceDefinition[] {
    return Object.entries(presence.states).map(([id, state]) => {
        const builtIn = BUILT_IN_PRESENCE_DEFINITIONS.find((candidate) => candidate.id === id);
        return {
            id,
            status: builtIn?.status ?? "custom",
            title: state.title ?? builtIn?.title ?? id,
            emoji: state.emoji ?? builtIn?.emoji ?? "🟣",
            prompt: state.prompt ?? builtIn?.prompt ?? "",
            answerWaitMs:
                state.answerWaitMs === undefined
                    ? (builtIn?.answerWaitMs ?? 0)
                    : state.answerWaitMs,
        };
    });
}

function configuredInitialPresence(
    presence: HappyAgentConfiguration["values"]["presence"],
): ConfiguredPresenceState | undefined {
    const current = presence.current;
    if (current === undefined) return undefined;
    const catalogIds = new Set([
        ...BUILT_IN_PRESENCE_DEFINITIONS.map((candidate) => candidate.id),
        ...Object.keys(presence.states),
    ]);
    if (!catalogIds.has(current)) {
        throw new Error(`Configured current presence "${current}" is not defined.`);
    }
    if (presence.fallback !== undefined && !catalogIds.has(presence.fallback)) {
        throw new Error(`Configured fallback presence "${presence.fallback}" is not defined.`);
    }
    return {
        presenceId: current,
        ...(presence.fallback === undefined ? {} : { fallbackPresenceId: presence.fallback }),
        ...(presence.until === undefined ? {} : { expiresAt: presence.until }),
    };
}

function assertExistingRootAgentConfig(config: AgentConfig, publicHome: string): void {
    const compute = config.modules?.compute;
    if (
        !Value.Check(agentComputeConfigSchema, compute) ||
        resolve((compute as { readonly cwd: string }).cwd) !== publicHome ||
        ((compute as { readonly providerId?: string }).providerId ?? "host") !== "host"
    ) {
        throw new Error(
            "The stored root agent does not have the expected host compute configuration.",
        );
    }
}

function createLoaderStateModule(
    setIdentity: (identity: {
        readonly epoch: string;
        readonly rootAgentId: string;
        readonly schemaVersion: number;
    }) => void,
): AgentModule<AnyAgentTool, LibSQLDatabase> {
    return {
        name: "happy-agent-loader",
        migrations: [
            [
                "001-root-agent",
                async (_ctx, database) => {
                    await agentDatabaseRun(
                        database,
                        sql`CREATE TABLE IF NOT EXISTS happy_agent_loader_state (
                            key TEXT PRIMARY KEY,
                            value TEXT NOT NULL
                        )`,
                    );
                },
            ],
        ],
        beforeStart: async (ctx) => {
            setIdentity(await ctx.inTx(async (txCtx) => await ensureLoaderIdentity(txCtx.db)));
        },
    };
}

async function ensureLoaderIdentity(database: AgentDatabase): Promise<{
    readonly epoch: string;
    readonly rootAgentId: string;
    readonly schemaVersion: number;
}> {
    const rows = await agentDatabaseRows<{ key: string; value: string }>(
        database,
        sql`SELECT key, value FROM happy_agent_loader_state
            WHERE key IN ('root_agent_id', 'installation_epoch', 'schema_version')`,
    );
    const values = new Map(rows.map((row) => [row.key, row.value]));
    const rootAgentIdValue = values.get("root_agent_id");
    const rootAgentId =
        rootAgentIdValue === undefined
            ? createId()
            : Value.Check(rootAgentIdSchema, rootAgentIdValue)
              ? rootAgentIdValue
              : undefined;
    if (rootAgentId === undefined || !Value.Check(rootAgentIdSchema, rootAgentId)) {
        throw new Error("The stored root agent identity is invalid.");
    }
    const epoch = values.get("installation_epoch") ?? randomUUID();
    const schemaVersionValue = values.get("schema_version");
    const schemaVersion =
        schemaVersionValue === undefined ? 1 : Number.parseInt(schemaVersionValue, 10);
    if (!Number.isSafeInteger(schemaVersion) || schemaVersion < 1) {
        throw new Error("The stored Happy agent schema version is invalid.");
    }
    for (const [key, value] of [
        ["root_agent_id", rootAgentId],
        ["installation_epoch", epoch],
        ["schema_version", String(schemaVersion)],
    ] as const) {
        if (!values.has(key)) {
            await agentDatabaseRun(
                database,
                sql`INSERT INTO happy_agent_loader_state (key, value)
                    VALUES (${key}, ${value})`,
            );
        }
    }
    return { epoch, rootAgentId, schemaVersion };
}

async function prepareHomes(configuration: HappyAgentConfiguration): Promise<void> {
    await mkdir(configuration.paths.agentHome, { mode: 0o700, recursive: true });
    await chmod(configuration.paths.agentHome, 0o700);
    await Promise.all([
        mkdir(configuration.paths.publicHome, { mode: 0o755, recursive: true }),
        mkdir(configuration.paths.appletsPath, { mode: 0o755, recursive: true }),
        mkdir(configuration.paths.generatedPath, { mode: 0o755, recursive: true }),
        mkdir(configuration.paths.workletsPath, { mode: 0o755, recursive: true }),
    ]);
}

function assertLoaderInput(options: LoadHappyAgentOptions): void {
    if (!Value.Check(happyAgentConfigurationSchema, options.configuration)) {
        throw new Error("The Happy agent configuration is invalid.");
    }
    if (options.configModule.configuration !== options.configuration) {
        throw new Error(
            "The Happy Agent config module and configuration must be the same snapshot.",
        );
    }
    if (!Value.Check(loaderProviderInputSchema, { provider: options.provider })) {
        throw new Error("The Happy agent loader provider is invalid.");
    }
    if (!Value.Check(Type.Array(modelSchema, { minItems: 1, maxItems: 1_000 }), options.models)) {
        throw new Error("The Happy agent loader models are invalid.");
    }
    if (!Value.Check(effectiveSelectionSchema, options.effectiveSelection)) {
        throw new Error("The Happy agent effective selection is invalid.");
    }
}
