import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
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
    withAgentDatabase,
    type Agent,
    type AgentConfig,
    type AgentDatabase,
    type AgentModel,
    type AgentModule,
    type AgentModuleScope,
    type AgentProviders,
    type AnyAgentTool,
} from "@slopus/happy-agent-base";
import { hostComputeProvider } from "@slopus/happy-agent-compute";
import {
    AUTO_PERMISSION_REVIEW_BUDGET_MS,
    AutoModule,
    boundSecurityFileText,
    isMissingSecurityFileError,
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
    permissionEventSchema,
    PresenceModule,
    ProjectsModule,
    SchedulingModule,
    SearchModule,
    SecretsModule,
    SkillsModule,
    SystemPromptModule,
    TasksModule,
    UsageModule,
    UserInputModule,
    WorkflowsModule,
    WorkspacesModule,
    agentComputeConfigSchema,
    createComputeModules,
    happyAgentConfigurationSchema,
    type EventsModuleOptions,
    type HappyHost,
    type HostCompute,
    type ImageGenerator,
    type McpHost,
    type PermissionReviewer,
    type SecretResolver,
    type WorkflowRuntime,
    type PresenceModuleOptions,
} from "@slopus/happy-agent-modules";
import { sql } from "drizzle-orm";
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import { detach, type Context } from "@steve.kite/stdlib";

import { checkModuleToolParameters } from "./checkModuleToolParameters.js";
import { openHappyAgentDatabase, type HappyAgentDatabase } from "./HappyAgentDatabase.js";
import { acquireHappyAgentStorageLock } from "./HappyAgentStorageLock.js";
import { readGlobalInstructions } from "./readGlobalInstructions.js";
import type { HappyAgentConfiguration } from "@slopus/happy-agent-modules";
import { ConversationModule } from "../conversations/ConversationModule.js";
import { GitStateTracker } from "../git/GitStateTracker.js";
import { directGitCommandRunner } from "../git/runGitCommand.js";
import type { WorkspaceNameGenerator } from "../projects/generateWorkspaceNames.js";
import type { ProjectCreatorProfile } from "../projects/ProjectHost.js";
import { ProjectWorkspaceService } from "../projects/ProjectWorkspaceService.js";
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
    readonly happy: HappyHost;
    readonly imageGeneration: ImageGenerator;
    readonly mcp: McpHost;
    readonly workflows: WorkflowRuntime;
    readonly permissionReviewer?: PermissionReviewer;
    readonly secretResolver?: SecretResolver;
    /**
     * Names a workspace, its branch and its chat from the first thing a person said. Choosing a
     * cheap model of the session's own provider is inference wiring, so the host supplies it.
     */
    readonly workspaceNames?: WorkspaceNameGenerator;
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
    readonly systemPrompt: SystemPromptModule;
    readonly tasks: TasksModule;
    readonly usage: UsageModule;
    readonly userInput: UserInputModule;
    readonly workflows: WorkflowsModule;
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
    /** The one live Git watcher every route shares instead of scanning once per request. */
    readonly gitTracker: GitStateTracker;
    /** Git, managed folders, worktrees, clones and setup behind the project and workspace catalogs. */
    readonly projectWorkspaces: ProjectWorkspaceService;
    /**
     * Starts work a request must not wait for, on its own named lifetime with the database
     * attached. Closing the agent waits for whatever is still running and starts nothing new.
     */
    readonly background: (name: string, work: (ctx: Context) => Promise<void>) => void;
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
    // The automatic permission reviewer's own resources, owned by the loader and cleaned up in the
    // same reverse order as the main system's whether startup succeeds or fails.
    let auto: AutoModule | undefined;
    let autoOpened: HappyAgentDatabase | undefined;
    let reviewerCompute: HostCompute | undefined;
    let projectWorkspaces: ProjectWorkspaceService | undefined;
    let gitTracker: GitStateTracker | undefined;
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

        // The review system is owned by the loader's lifetime, not by any turn, permission hook, or
        // tool call, so it takes the loader context directly — the same lifetime the main system
        // uses, closed by the loader in the same reverse order. It opens its own SQLite connection
        // and single-owner lock beside, never on top of, the main agent's files, so a reviewer
        // shares no state with the agent it reviews. A lock already held by another process is a
        // clean, explained refusal to start Auto mode rather than an opaque crash.
        const autoLifetime = ctx;
        const autoDatabasePath = configuration.paths.autoDatabasePath;
        autoOpened = await openHappyAgentDatabase(autoDatabasePath);
        await chmod(autoDatabasePath, 0o600);
        const autoStorage = new AgentStorage({
            acquireLock: async () => {
                try {
                    return await acquireHappyAgentStorageLock(
                        configuration.paths.autoAgentLockPath,
                    );
                } catch (error: unknown) {
                    throw new Error(
                        "Auto mode cannot start because the automatic permission reviewer store " +
                            "is already in use by another process.",
                        { cause: error },
                    );
                }
            },
            database: autoOpened.database,
        });

        // Everything a project or a workspace record describes but cannot do is composed on this
        // root. `detach` is what gives the background work a root: the loader's own context ends
        // with a request or a turn, while a clone, a setup command or a worktree removal has to
        // outlive whatever asked for it, and a detached root still carries the logger and the
        // tracer. The database is not on that root, so every background lifetime gets it attached —
        // without that, a catalog write from a background job would find no database and fail
        // silently.
        const hostRoot = detach(ctx);
        const backgroundDatabase = (backgroundCtx: Context): Context =>
            withAgentDatabase(backgroundCtx, opened.database);
        const built = await createModules(
            autoLifetime,
            backgroundDatabase(hostRoot.named("workspace-folder-cleanup")),
            options.configModule,
            options.observation,
            options.integrations,
            options.models,
            options.events,
            {
                storage: autoStorage,
                providers: options.providers,
                provider: options.provider,
                lifetimeContext: autoLifetime,
            },
        );
        modules = built.modules;
        auto = built.auto;
        reviewerCompute = built.reviewerCompute;
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
            // The reviewer's evidence archive lives in the main database and observes the same base
            // hooks the reviewed agents emit, so it is a main-system module ordered right after
            // permissions. Its private review system is not part of the module collection and is
            // never returned, listed, or otherwise made addressable.
            auto,
            modules.presence,
            modules.goal,
            modules.tasks,
            modules.usage,
            modules.projects,
            modules.workspaces,
            modules.secrets,
            modules.collaboration,
            modules.scheduling,
            modules.userInput,
            modules.workflows,
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

        projectWorkspaces = new ProjectWorkspaceService({
            agentId,
            extendBackgroundContext: backgroundDatabase,
            // One machine, one person: the daemon is the instance, and the only profile it can
            // resolve is whoever this copy of Git commits as.
            localCreator: { instanceId: agentId, profileId: LOCAL_PROJECT_PROFILE_ID },
            localInstanceId: agentId,
            ...(options.integrations.workspaceNames === undefined
                ? {}
                : { nameGenerator: options.integrations.workspaceNames }),
            onWorkspaceBranchError: (error, projectId, workspaceId) => {
                ctx.log.warn(
                    "Renaming a workspace branch failed; the record and Git now disagree.",
                    { projectId, workspaceId },
                    error,
                );
            },
            onWorkspaceCleanupError: (error, projectId, workspaceId) => {
                ctx.log.warn(
                    "Removing an archived workspace folder failed; it stays archived and on disk.",
                    { projectId, workspaceId },
                    error,
                );
            },
            projects: modules.projects,
            resolveGitSecret: (kind) =>
                kind === "github" ? localGithubToken(process.env) : undefined,
            resolveProfile: async (profileId) =>
                profileId === LOCAL_PROJECT_PROFILE_ID ? await localGitProfile(agentId) : undefined,
            rootContext: hostRoot,
            settings: configuration.values.workspace,
            // Avatar bytes are content a person chose and expects to survive a restart, so they
            // live beside the agent's own database rather than in a temporary folder.
            stateDirectory: join(configuration.paths.agentHome, "projects"),
            workspaces: modules.workspaces,
        });
        built.attachProjectWorkspaces(projectWorkspaces);
        // One watcher for the whole daemon. Every route that wants Git state registers here and
        // reads what the watcher already knows, instead of each request scanning repositories
        // itself. What a scan learns is written back through the catalogs, so a snapshot taken for
        // one reader becomes a durable fact for every later one.
        gitTracker = new GitStateTracker({
            onObserverError: (_observerCtx, error, entity) => {
                ctx.log.debug("A Git watcher could not be armed.", { path: entity.path }, error);
            },
            onSnapshot: async (snapshotCtx, entity, snapshot) => {
                await projectWorkspaces!.gitSnapshotObserver(
                    backgroundDatabase(snapshotCtx),
                    entity,
                    snapshot,
                );
            },
            rootContext: hostRoot,
        });
        await projectWorkspaces.open(withAgentDatabase(ctx, opened.database));

        let closed = false;
        // A route that answers "this is under way" still owes the work. It runs off the same
        // detached root the host uses, so it survives the request, and the close below waits for
        // it rather than pulling the database out from under it.
        const backgroundTasks = new Set<Promise<void>>();
        const background = (name: string, work: (workerCtx: Context) => Promise<void>): void => {
            if (closed) return;
            const task = work(backgroundDatabase(hostRoot.named(name)))
                .catch((error: unknown) => {
                    ctx.log.warn(`Background work "${name}" failed.`, {}, error);
                })
                .finally(() => {
                    backgroundTasks.delete(task);
                });
            backgroundTasks.add(task);
        };
        return {
            agent,
            background,
            gitTracker,
            projectWorkspaces,
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
                while (backgroundTasks.size > 0) {
                    await Promise.allSettled([...backgroundTasks]);
                }
                // The Git watcher and the project host stop before the systems that own their
                // database: both write through the catalogs from background lifetimes, and a write
                // arriving after the database closed is the one failure nobody would see.
                gitTracker?.dispose();
                await projectWorkspaces
                    ?.close(withAgentDatabase(closeCtx, opened.database))
                    .catch((error: unknown) => failures.push(error));
                // The main system closes first so it drains in-flight permission hooks, and only
                // then the review system, its reviewer compute, and its database. The reviewer's
                // own lock is released as its private system closes; the main compute and database
                // close last, exactly as they opened first.
                await system!.close(closeCtx).catch((error: unknown) => failures.push(error));
                await auto?.close(closeCtx).catch((error: unknown) => failures.push(error));
                if (reviewerCompute !== undefined) {
                    await reviewerCompute
                        .dispose(closeCtx)
                        .catch((error: unknown) => failures.push(error));
                }
                try {
                    autoOpened?.close();
                } catch (error) {
                    failures.push(error);
                }
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
        gitTracker?.dispose();
        if (projectWorkspaces !== undefined) {
            await projectWorkspaces
                .close(withAgentDatabase(ctx, opened.database))
                .catch((closeError: unknown) => failures.push(closeError));
        }
        if (system !== undefined) {
            await system.close(ctx).catch((closeError: unknown) => failures.push(closeError));
        }
        if (auto !== undefined) {
            await auto.close(ctx).catch((closeError: unknown) => failures.push(closeError));
        }
        if (reviewerCompute !== undefined) {
            await reviewerCompute
                .dispose(ctx)
                .catch((closeError: unknown) => failures.push(closeError));
        }
        try {
            autoOpened?.close();
        } catch (closeError) {
            failures.push(closeError);
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

interface CreatedHappyAgentModules {
    readonly modules: HappyAgentModuleCollection;
    /** The automatic permission reviewer, a main-system module kept out of the public collection. */
    readonly auto: AutoModule;
    /** The host-owned, read-only compute the reviewer's tools run over, disposed by the loader. */
    readonly reviewerCompute: HostCompute;
    /**
     * Hands the catalogs their host once it exists. The projects and workspaces modules have to be
     * built before the root agent is known, and the host service needs both modules and that agent
     * id, so the modules receive callbacks that stay inert until this is called.
     */
    readonly attachProjectWorkspaces: (service: ProjectWorkspaceService) => void;
}

async function createModules(
    autoLifetime: Context,
    workspaceCleanupLifetime: Context,
    configModule: ConfigModule,
    observation: ObservationModule,
    integrations: HappyAgentIntegrations,
    models: readonly AgentModel[],
    events: EventsModuleOptions | undefined,
    autoOptions: {
        readonly storage: AgentStorage;
        readonly providers: AgentProviders;
        readonly provider: string;
        readonly lifetimeContext: Context;
    },
): Promise<CreatedHappyAgentModules> {
    const { configuration } = configModule;
    // Gemini is not one of the accounts a chat runs on, so its search reads a key from the
    // environment rather than from a configured provider.
    const geminiApiKey = process.env.GEMINI_API_KEY?.trim() || undefined;
    // The catalogs and their host need each other: a workspace reservation asks Git which branches
    // are taken, and the host reads and writes through the very modules built here. The host is
    // also keyed by the root agent, which does not exist until after these modules are assembled.
    // Holding it in a box the catalogs read through breaks the knot. Attaching happens a few lines
    // after the root agent resolves and before anything can serve a request, so a callback that
    // runs before then is a composition bug rather than a configuration a caller can be in; saying
    // so plainly beats inventing a folder or a branch answer nothing stands behind.
    const projectWorkspaces: { service: ProjectWorkspaceService | undefined } = {
        service: undefined,
    };
    const hostService = (): ProjectWorkspaceService => {
        const service = projectWorkspaces.service;
        if (service === undefined) {
            throw new Error("Projects and workspaces were used before their host was composed.");
        }
        return service;
    };
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
    // Conversation and Events are built before Permissions so the permission listener can record
    // into both the moment a decision is made. The Events journal is the bounded protocol source
    // that carries a permission event to the transcript, SSE, and the TUI; the conversation journal
    // is a secondary record whose failure is observed rather than allowed to break a decision.
    const conversations = new ConversationModule({ defaultCwd: configuration.paths.publicHome });
    const eventsModule = new EventsModule(events);

    // The system prompt module reads the project's AGENTS.md through each agent's own compute, so
    // it is built here and shared: the reviewer rereads the same project instructions the reviewed
    // agent sees, resolved against that agent's working directory.
    const systemPrompt = new SystemPromptModule({
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
    });

    // The reviewer investigates local state through a read-only compute the loader owns, at the
    // public working directory and behind the same sandbox policy as the main agent. Its private
    // review database is treated as a private directory so a review can never read the reviewer's
    // own state. The reviewer's tools are the vendor-specific read-only slice, chosen per review
    // from the reviewer's own model route.
    const reviewerCompute = (await hostComputeProvider.create(autoLifetime, {
        cwd: configuration.paths.publicHome,
        hostPolicy: {
            privateDirectories: [configuration.paths.agentHome],
            protectedProjectFiles,
        },
    })) as HostCompute;

    let auto: AutoModule;
    try {
        const readBoundedSecurity = async (path: string): Promise<string | undefined> => {
            try {
                return boundSecurityFileText(await readFile(path));
            } catch (error: unknown) {
                if (isMissingSecurityFileError(error)) return undefined;
                throw error;
            }
        };
        auto = new AutoModule({
            storage: autoOptions.storage,
            providers: autoOptions.providers,
            provider: autoOptions.provider,
            models: [...models],
            workingDirectory: configuration.paths.publicHome,
            lifetimeContext: autoOptions.lifetimeContext,
            reviewerTools: (scope: AgentModuleScope) =>
                compute.computeModule.reviewerTools(scope, reviewerCompute),
            readGlobalSecurity: async () =>
                await readBoundedSecurity(configuration.paths.securityPath),
            readProjectSecurity: async () =>
                await readBoundedSecurity(
                    join(configuration.paths.publicHome, "AGENTS_SECURITY.md"),
                ),
            readAgentsMd: async (reviewCtx, agentId) =>
                await systemPrompt.readAgentsMdInstructions(reviewCtx, agentId),
        });
    } catch (error) {
        await reviewerCompute.dispose(autoLifetime).catch(() => undefined);
        throw error;
    }

    const permissions = new PermissionsModule({
        // The automatic permission reviewer replaces the old "no reviewer configured" state that
        // left every reviewable Auto action unproven. A host may still inject an explicit reviewer.
        reviewer: integrations.permissionReviewer ?? auto.reviewer,
        // One review may take exactly the Rig v1 budget before an unanswered review is treated as
        // unproven rather than left to hang the turn.
        reviewTimeoutMs: AUTO_PERMISSION_REVIEW_BUDGET_MS,
        listener: {
            onEvent: async (listenerCtx, event) => {
                // Validate at the persistence boundary. The module hands us a typed event, but the
                // journals store it as opaque JSON and the projection later narrows it from the
                // decoded value; persisting anything that would not decode back to a permission
                // event would put a row on the wire that the projector must silently drop. Guarding
                // here keeps a malformed event out of the durable record and makes the loss visible.
                // Validate a value typed as `unknown` rather than `event` itself: the event is
                // already typed as a permission event, so letting the type guard narrow the failing
                // branch would collapse `event` to `never`. Guarding the alias keeps `event` usable
                // for the log while the runtime check does its real job.
                const candidate: unknown = event;
                if (!Value.Check(permissionEventSchema, candidate)) {
                    listenerCtx.log.warn(
                        "Refusing to record a permission event that does not match its schema.",
                        { agentId: event.agentId, type: event.type },
                    );
                    return;
                }
                try {
                    await conversations.recordAgentEvent(
                        listenerCtx,
                        event.agentId,
                        "permission_event",
                        event,
                    );
                } catch (error: unknown) {
                    // The conversation journal is a secondary record; the Events journal below is
                    // the source of truth a client actually reads a permission event from. The
                    // failure is not fatal, but it must be visible: an operator has to be able to
                    // learn that this agent's permission history is now incomplete.
                    listenerCtx.log.warn(
                        "Failed to record a permission event in the conversation journal.",
                        { agentId: event.agentId, type: event.type },
                        error,
                    );
                }
                await eventsModule.record(listenerCtx, {
                    agentId: event.agentId,
                    type: "permission.event",
                    payload: event,
                });
            },
        },
        killAllSessions: async (_ctx, agentId) => {
            for (const session of compute.computeModule.runningCommands(agentId)) {
                await compute.computeModule.stopCommand(agentId, session.sessionId);
            }
        },
    });
    const modules: HappyAgentModuleCollection = {
        config: configModule,
        observation,
        collaboration: new CollaborationModule(),
        conversations,
        compute: compute.computeModule,
        events: eventsModule,
        goal: new GoalModule({}),
        happy: new HappyModule({ host: integrations.happy }),
        history,
        imageGeneration: new ImageGenerationModule({
            generator: integrations.imageGeneration,
            outputDirectory: configuration.paths.generatedPath,
        }),
        mcp: new McpModule({ host: integrations.mcp }),
        modelSwitch: new ModelSwitchModule({ history }),
        permissions,
        presence,
        projects: new ProjectsModule({
            crossWorkspace: configuration.values.features.crossWorkspace,
            avatarAssetReader: {
                read: async (avatarCtx, agentId, hash) =>
                    await hostService().avatarAssetReader.read(avatarCtx, agentId, hash),
            },
        }),
        scheduling: new SchedulingModule(),
        search: new SearchModule({
            providers: autoOptions.providers,
            models,
            currentProviderId: autoOptions.provider,
            bedrockSearchModels: bedrockSearchModels(configuration),
            ...(geminiApiKey === undefined ? {} : { geminiApiKey }),
        }),
        secrets: new SecretsModule(
            integrations.secretResolver === undefined
                ? {}
                : { resolveForHost: integrations.secretResolver },
        ),
        skills: compute.skillsModule,
        systemPrompt,
        tasks: new TasksModule({}),
        usage: new UsageModule({}),
        userInput: new UserInputModule({
            presence: presence.userInputPolicy,
            // Only a genuine human answer to an interactive request becomes trusted evidence for a
            // later permission review. Provenance is decided by the actor: a human answers through
            // the client on behalf of the asking agent's own request, so the acting agent equals the
            // asking agent; an agent answering another agent's request (a collaboration hand-off) has
            // a different acting agent and is not human authorization. Trusting the answer without
            // this check would let a non-human answerer manufacture human evidence, so an answer from
            // any other actor is skipped and stays untrusted context. The request ID is the provider
            // call ID, which is the same call ID the tool result carries, so the reviewer can match
            // the recorded answer to the action it authorizes. Recording transactionally commits the
            // evidence atomically with the answer; a failure here degrades to untrusted context
            // rather than rolling back the user's answer.
            listener: {
                onEventTransactional: async (listenerCtx, event) => {
                    if (event.type !== "user_input_answered") return;
                    if (event.actingAgentId !== event.request.askingAgentId) return;
                    try {
                        await auto.recordUserInputEventTransactional(listenerCtx, {
                            type: "user_input_answered",
                            agentId: event.request.askingAgentId,
                            requestId: event.requestId,
                            answer: JSON.stringify(event.request.answers ?? event.request.answer),
                        });
                    } catch {
                        // Fail-safe: an unrecorded answer stays untrusted, which under-authorizes
                        // rather than over-authorizes. Never let it break saving the human's answer.
                    }
                },
                // A client learns about a question, and about how it ended, from the event journal
                // it already streams. Publishing after the transition has committed is what keeps
                // the client from ever showing a question the database does not hold. A journal
                // failure is reported rather than thrown: the module has already woken its wait.
                onEvent: async (listenerCtx, event) => {
                    try {
                        await eventsModule.record(listenerCtx, {
                            agentId: event.request.askingAgentId,
                            type: "user_input.event",
                            payload: event,
                        });
                    } catch (error: unknown) {
                        listenerCtx.log.warn(
                            "Failed to record a user input event in the event journal.",
                            { agentId: event.request.askingAgentId, type: event.type },
                            error,
                        );
                    }
                },
            },
        }),
        workflows: new WorkflowsModule({
            enabled: configuration.values.features.workflows,
            runtime: integrations.workflows,
        }),
        workspaces: new WorkspacesModule({
            // Removing a workspace's folder is the consequence of an archive that has already been
            // recorded, so it runs on the daemon's own lifetime rather than on the request that
            // asked for it and would be gone before the folder is.
            cleanupContext: workspaceCleanupLifetime,
            enabled: configuration.values.features.workspaces,
            host: {
                pathForStorageKey: (projectRef, storageKey) =>
                    hostService().workspaceCatalogHost.pathForStorageKey(projectRef, storageKey),
                isBranchUnavailable: (projectRef, branch) =>
                    hostService().workspaceCatalogHost.isBranchUnavailable(projectRef, branch),
                isStorageKeyUnavailable: (projectRef, storageKey) =>
                    hostService().workspaceCatalogHost.isStorageKeyUnavailable(
                        projectRef,
                        storageKey,
                    ),
            },
        }),
    };
    return {
        modules,
        auto,
        reviewerCompute,
        attachProjectWorkspaces: (service) => {
            projectWorkspaces.service = service;
        },
    };
}

/**
 * The only profile a single-machine daemon can resolve.
 *
 * Profiles are a multi-instance idea: a project created on one machine records who created it so
 * another machine can refuse to clone with the wrong person's credentials. A local daemon has
 * exactly one person behind it, so it names that profile once and answers for it below.
 */
const LOCAL_PROJECT_PROFILE_ID = "local";

/** A GitHub token from the environment, under either of the two names the tooling uses. */
function localGithubToken(environment: NodeJS.ProcessEnv): string | undefined {
    for (const name of ["GITHUB_TOKEN", "GH_TOKEN"] as const) {
        const value = environment[name]?.trim();
        if (value !== undefined && value.length > 0) return value;
    }
    return undefined;
}

/**
 * Who this machine commits as, read from Git's own configuration.
 *
 * A clone made on someone's behalf writes commits, and commits need a name and an address. Asking
 * Git is the honest answer: it is the same identity the person's own commits already carry. When
 * Git has nothing configured the clone is refused rather than attributed to an invented person.
 */
async function localGitProfile(instanceId: string): Promise<ProjectCreatorProfile | undefined> {
    const read = async (key: string): Promise<string | undefined> => {
        const result = await directGitCommandRunner.run(homedir(), ["config", "--get", key], {
            maxOutputBytes: 4096,
        });
        if (result.code !== 0) return undefined;
        const value = result.stdout.trim();
        return value.length > 0 ? value : undefined;
    };
    const [email, name] = await Promise.all([read("user.email"), read("user.name")]);
    if (email === undefined || name === undefined) return undefined;
    return { email, name, parentInstanceId: instanceId };
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
        mkdir(configuration.paths.generatedPath, { mode: 0o755, recursive: true }),
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

/** Bedrock serves its hosted index from particular models, so an account may name its own. */
function bedrockSearchModels(configuration: HappyAgentConfiguration): Record<string, string> {
    const models: Record<string, string> = {};
    for (const [id, provider] of Object.entries(configuration.values.providers)) {
        if (provider.enabled === false || provider.type !== "bedrock") continue;
        if (provider.searchModelId !== undefined) models[id] = provider.searchModelId;
    }
    return models;
}
