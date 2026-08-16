import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { chmod, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";

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
    AgentsMdModule,
    AppletModule,
    CollaborationModule,
    ComputeModule,
    GoalModule,
    HappyModule,
    HistoryModule,
    ImageGenerationModule,
    McpModule,
    ModelSwitchModule,
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
    type CollaborationBroker,
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
} from "@slopus/happy-agent-modules";
import { sql } from "drizzle-orm";
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import type { Context } from "@steve.kite/stdlib";

import { openHappyAgentDatabase } from "./HappyAgentDatabase.js";
import { acquireHappyAgentStorageLock } from "./HappyAgentStorageLock.js";
import { EventsModule, type EventsModuleOptions } from "../events/EventsModule.js";
import { ConversationModule } from "../conversations/ConversationModule.js";

const pathSchema = Type.String({ minLength: 1, maxLength: 4_096 });
const providerSchema = Type.String({ minLength: 1, maxLength: 256 });
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
const loaderInputSchema = Type.Object(
    {
        agentHome: pathSchema,
        provider: providerSchema,
        publicHome: pathSchema,
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
    /** Private state, normally `~/.happy/agent` on macOS. */
    readonly agentHome: string;
    /** User-visible files and the host compute root, normally `~/Happy`. */
    readonly publicHome: string;
    readonly integrations: HappyAgentIntegrations;
    readonly providers: AgentProviders;
    readonly provider: string;
    readonly models: readonly AgentModel[];
    readonly config?: AgentConfig;
    readonly events?: EventsModuleOptions;
}

export interface HappyAgentModuleCollection {
    readonly agentsMd: AgentsMdModule;
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
    readonly agentHome: string;
    readonly compute: ComputeModule;
    readonly database: LibSQLDatabase;
    readonly databasePath: string;
    readonly modules: HappyAgentModuleCollection;
    readonly publicHome: string;
    readonly installation: {
        readonly epoch: string;
        readonly schemaVersion: number;
    };
    readonly storage: AgentStorage<LibSQLDatabase>;
    readonly system: AgentSystemLocal<LibSQLDatabase>;
    close(ctx: Context): Promise<void>;
}

/**
 * Load one durable Happy agent and every standard module over a private home and public home.
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
    const agentHome = expandHome(options.agentHome);
    const publicHome = expandHome(options.publicHome);
    if (agentHome === publicHome) {
        throw new Error("The private agent home and public Happy home must be different folders.");
    }
    await prepareHomes(agentHome, publicHome);

    const databasePath = join(agentHome, "agent.sqlite");
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
                await acquireHappyAgentStorageLock(join(agentHome, "agent.lock")),
            database: opened.database,
        });
        modules = createModules(options.integrations, agentHome, publicHome, options.events);
        const loaderStateModule = createLoaderStateModule((identity) => {
            loaderIdentity = identity;
        });
        const orderedModules: AgentModule<AnyAgentTool, LibSQLDatabase>[] = [
            modules.systemPrompt,
            modules.conversations,
            modules.history,
            modules.modelSwitch,
            modules.agentsMd,
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
        ];
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
        const config = rootAgentConfig(options.config, publicHome);
        if (existing !== undefined) assertExistingRootAgentConfig(existing, publicHome);
        const agent =
            existing === undefined
                ? await system.create(ctx, config, { id: agentId }).catch((error: unknown) => {
                      throw new Error("Creating the root Happy Agent failed.", { cause: error });
                  })
                : await system.resolve(ctx, agentId);

        let closed = false;
        return {
            agent,
            agentHome,
            compute: modules.compute,
            database: opened.database,
            databasePath,
            modules,
            publicHome,
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
    integrations: HappyAgentIntegrations,
    agentHome: string,
    publicHome: string,
    events: EventsModuleOptions | undefined,
): HappyAgentModuleCollection {
    const history = new HistoryModule();
    const compute = createComputeModules({
        provider: {
            id: "host",
            create: async (ctx, config) =>
                await hostComputeProvider.create(ctx, {
                    ...config,
                    hostPolicy: {
                        privateDirectories: [agentHome],
                        protectedProjectFiles: ["AGENTS.md", "AGENTS_SECURITY.md"],
                    },
                }),
        },
    });
    return {
        agentsMd: compute.agentsMdModule,
        applets: new AppletModule({ rootDirectory: join(publicHome, "Applets") }),
        collaboration: new CollaborationModule({ broker: integrations.collaboration }),
        conversations: new ConversationModule({ defaultCwd: publicHome }),
        compute: compute.computeModule,
        events: new EventsModule(events),
        goal: new GoalModule({}),
        happy: new HappyModule({ host: integrations.happy }),
        history,
        imageGeneration: new ImageGenerationModule({
            generator: integrations.imageGeneration,
            outputDirectory: join(publicHome, "Generated"),
        }),
        mcp: new McpModule({ host: integrations.mcp }),
        modelSwitch: new ModelSwitchModule({ history }),
        permissions: new PermissionsModule(
            integrations.permissionReviewer === undefined
                ? {}
                : { reviewer: integrations.permissionReviewer },
        ),
        presence: new PresenceModule(),
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
        systemPrompt: new SystemPromptModule(),
        tasks: new TasksModule({}),
        usage: new UsageModule({}),
        userInput: new UserInputModule({ broker: integrations.userInput }),
        workflows: new WorkflowsModule({ runtime: integrations.workflows }),
        worklets: new WorkletsModule({
            installRoot: join(publicHome, "Worklets"),
            runtime: integrations.worklets,
        }),
        workspaces: new WorkspacesModule(
            integrations.workspaceHost === undefined ? {} : { host: integrations.workspaceHost },
        ),
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

async function prepareHomes(agentHome: string, publicHome: string): Promise<void> {
    await mkdir(agentHome, { mode: 0o700, recursive: true });
    await chmod(agentHome, 0o700);
    await Promise.all([
        mkdir(publicHome, { mode: 0o755, recursive: true }),
        mkdir(join(publicHome, "Applets"), { mode: 0o755, recursive: true }),
        mkdir(join(publicHome, "Generated"), { mode: 0o755, recursive: true }),
        mkdir(join(publicHome, "Worklets"), { mode: 0o755, recursive: true }),
    ]);
}

function assertLoaderInput(options: LoadHappyAgentOptions): void {
    const candidate = {
        agentHome: options.agentHome,
        provider: options.provider,
        publicHome: options.publicHome,
    };
    if (!Value.Check(loaderInputSchema, candidate)) {
        throw new Error("The Happy agent loader paths or provider are invalid.");
    }
    if (!Value.Check(Type.Array(modelSchema, { minItems: 1, maxItems: 1_000 }), options.models)) {
        throw new Error("The Happy agent loader models are invalid.");
    }
}

function expandHome(path: string): string {
    if (path === "~") return homedir();
    if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
    return resolve(path);
}
