import { chmod, mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { createId } from "@paralleldrive/cuid2";
import {
    AgentStorage,
    AgentSystemLocal,
    agentDatabaseRows,
    agentDatabaseRun,
    currentAgentEnvironment,
    withAgentDatabase,
    type Agent,
    type AgentDatabase,
    type AgentModel,
    type AgentModule,
    type AgentProviders,
    type AnyAgentTool,
} from "@slopus/happy-agent-base";
import { hostComputeProvider } from "@slopus/happy-agent-compute";
import {
    AUTO_PERMISSION_REVIEW_BUDGET_MS,
    AutoModule,
    CollaborationModule,
    ComputeModule,
    ConfigModule,
    EventsModule,
    GoalModule,
    HistoryModule,
    ImageGenerationModule,
    ModelSwitchModule,
    ObservationModule,
    PermissionsModule,
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
    WorkspacesModule,
    boundSecurityFileText,
    createComputeModules,
    isMissingSecurityFileError,
    type HappyAgentConfiguration,
    type HostCompute,
    type PresenceModuleOptions,
} from "@slopus/happy-agent-modules";
import { sql } from "drizzle-orm";
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import { createRootContext, detach, type Context, type RootContext } from "@steve.kite/stdlib";

import { agentModels, agentProviders } from "./agentCatalog.js";
import { checkModuleToolParameters } from "../modules/agent/checkModuleToolParameters.js";
import { openHappyAgentDatabase } from "../modules/agent/HappyAgentDatabase.js";
import { acquireHappyAgentStorageLock } from "../modules/agent/HappyAgentStorageLock.js";
import { readGlobalInstructions } from "../modules/agent/readGlobalInstructions.js";
import { ConversationModule } from "../modules/conversations/ConversationModule.js";
import { GitStateTracker } from "../modules/git/GitStateTracker.js";
import { directGitCommandRunner } from "../modules/git/runGitCommand.js";
import type { ProjectCreatorProfile } from "../modules/projects/ProjectHost.js";
import { ProjectWorkspaceService } from "../modules/projects/ProjectWorkspaceService.js";

/** Everything a caller needs to say. Every other answer comes out of the configuration. */
export interface StartHappyAgentOptions {
    /** Happy's private root. Defaults to `~/.happy`. */
    readonly happyHome?: string;
    /** Human-readable version this process reports. */
    readonly version?: string;
    /**
     * Replaces the accounts and the catalog the configuration would otherwise build.
     *
     * This exists so a test can script inference without a vendor credential. Nothing in the
     * product supplies it, and everything else about starting stays exactly the same.
     */
    readonly inference?: {
        readonly models: readonly AgentModel[];
        readonly providers: AgentProviders;
    };
}

/** Every capability the agent runs with, addressable by name. */
export interface HappyAgentModules {
    readonly collaboration: CollaborationModule;
    readonly compute: ComputeModule;
    readonly config: ConfigModule;
    readonly conversations: ConversationModule;
    readonly events: EventsModule;
    readonly goal: GoalModule;
    readonly history: HistoryModule;
    readonly imageGeneration: ImageGenerationModule;
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
    readonly workspaces: WorkspacesModule;
}

export interface StartedHappyAgent {
    /** The root lifetime everything below was started on, already carrying logger and tracer. */
    readonly ctx: RootContext;
    readonly configuration: HappyAgentConfiguration;
    readonly provider: string;
    readonly providers: AgentProviders;
    readonly models: readonly AgentModel[];
    readonly database: LibSQLDatabase;
    readonly storage: AgentStorage<LibSQLDatabase>;
    readonly system: AgentSystemLocal<LibSQLDatabase>;
    readonly agent: Agent<AnyAgentTool, LibSQLDatabase>;
    readonly modules: HappyAgentModules;
    /** The one live Git watcher every reader shares instead of scanning once per request. */
    readonly gitTracker: GitStateTracker;
    /** Git, managed folders, worktrees, clones and setup behind the project and workspace catalogs. */
    readonly projectWorkspaces: ProjectWorkspaceService;
    /** What this `.happy` folder is, from the first time anyone started it here. */
    readonly installation: {
        readonly epoch: string;
        readonly schemaVersion: number;
    };
    /**
     * Starts work a caller must not wait for, on its own named lifetime with the database
     * attached. Closing waits for whatever is still running and starts nothing new.
     */
    readonly background: (name: string, work: (ctx: Context) => Promise<void>) => void;
    close(): Promise<void>;
}

/**
 * Start the complete Happy agent from one folder.
 *
 * Everything the agent can do lives in a module, and every module is built here from the
 * configuration and from the modules it depends on. There is no host, no injected service and no
 * capability that arrives from outside: a module that would need one does not exist.
 */
export async function startHappyAgent(
    options: StartHappyAgentOptions = {},
): Promise<StartedHappyAgent> {
    const config = await ConfigModule.load(options.happyHome);
    const configuration = config.configuration;
    const paths = configuration.paths;
    // Observation starts before anything it should be able to watch, and the root it installs its
    // logger and tracer on becomes the root every lifetime below is derived from. Contexts are
    // immutable, so a module started on the bare root would log nowhere for ever.
    const observation = await ObservationModule.start({
        configuration,
        ...(options.version === undefined ? {} : { version: options.version }),
    });
    const ctx = observation.install(createRootContext());
    // Everything opened below is closed in the reverse order it opened, and observation closes
    // last, so the last thing the agent did is still in the file a person reads to find out why it
    // stopped. It is in this list from the start: a configuration this folder cannot run refuses
    // between here and the first database, and that refusal must not leave a log file open.
    const unwind: (() => Promise<void> | void)[] = [async () => await observation.close(ctx)];
    let closed = false;
    const backgroundTasks = new Set<Promise<void>>();
    const close = async (): Promise<void> => {
        if (closed) return;
        closed = true;
        const failures: unknown[] = [];
        // Work a caller was told is under way still owes its result, and the database it writes
        // through must not be pulled out from under it.
        while (backgroundTasks.size > 0) await Promise.allSettled([...backgroundTasks]);
        for (const step of unwind.splice(0)) {
            try {
                await step();
            } catch (error) {
                failures.push(error);
            }
        }
        if (failures.length > 0) {
            throw new AggregateError(failures, "The Happy agent did not close cleanly.");
        }
    };

    try {
        // The private root holds credentials and databases; the public home is the folder the agent
        // works in and a person may open.
        await mkdir(paths.agentHome, { mode: 0o700, recursive: true });
        await chmod(paths.agentHome, 0o700);
        await mkdir(paths.publicHome, { mode: 0o755, recursive: true });
        await mkdir(paths.generatedPath, { mode: 0o755, recursive: true });

        const models = options.inference?.models ?? agentModels(configuration);
        // The catalog puts the configured default first, so the account serving it is the one every
        // agent starts on. Nothing else in the agent decides what a turn runs on: a caller names
        // that with the message it sends.
        const provider = models[0]?.providerId;
        if (provider === undefined) throw new Error("No model is enabled by the configuration.");
        const providers = options.inference?.providers ?? agentProviders(configuration);
        if (providers.typeOf(provider) === null) {
            throw new Error(`The configured default provider "${provider}" is not enabled.`);
        }

        // Two databases: the agent's own, and the reviewer's. A permission review must never read
        // or write the state of the agent it is reviewing, so they share neither file nor lock.
        const main = await openHappyAgentDatabase(paths.databasePath);
        unwind.unshift(() => main.close());
        await chmod(paths.databasePath, 0o600);
        const review = await openHappyAgentDatabase(paths.autoDatabasePath);
        unwind.unshift(() => review.close());
        await chmod(paths.autoDatabasePath, 0o600);

        const protectedProjectFiles = [
            ...new Set([
                "AGENTS.md",
                "AGENTS_SECURITY.md",
                ...configuration.values.permissions.protectedPaths,
                ...configuration.values.workspace.protectedSync,
            ]),
        ];
        const hostPolicy = { privateDirectories: [paths.agentHome], protectedProjectFiles };

        // Work that outlives whatever asked for it — a clone, a setup command, a worktree removal —
        // runs on a detached root that still carries the logger and the tracer. The database is not
        // on that root, so every such lifetime gets it attached, or a catalog write from background
        // work would find no database at all.
        const hostRoot = detach(ctx);
        const withDatabase = (target: Context): Context => withAgentDatabase(target, main.database);
        const background = (name: string, work: (workerCtx: Context) => Promise<void>): void => {
            if (closed) return;
            const task = work(withDatabase(hostRoot.named(name)))
                .catch((error: unknown) => {
                    ctx.log.warn(`Background work "${name}" failed.`, {}, error);
                })
                .finally(() => {
                    backgroundTasks.delete(task);
                });
            backgroundTasks.add(task);
        };

        const compute = createComputeModules({
            provider: {
                id: "host",
                create: async (computeCtx, computeConfig) =>
                    await hostComputeProvider.create(computeCtx, { ...computeConfig, hostPolicy }),
            },
        });
        unwind.unshift(async () => await compute.computeModule.dispose(ctx));

        const history = new HistoryModule({ onAppend: observation.recordHistory });
        const conversations = new ConversationModule({ defaultCwd: paths.publicHome });
        const events = new EventsModule();
        const presence = new PresenceModule(presenceOptions(configuration));

        // The system prompt reads each agent's own AGENTS.md through that agent's compute, so the
        // reviewer below sees exactly the project instructions the reviewed agent sees.
        const systemPrompt = new SystemPromptModule({
            availableModels: models.map(({ id, name, providerId }) => ({ id, name, providerId })),
            compute: {
                resolve: async (resolveCtx, agentId) =>
                    await compute.computeModule.resolve(resolveCtx, agentId),
            },
            globalInstructions: { path: paths.instructionsPath, read: readGlobalInstructions },
        });

        // The reviewer investigates local state through its own read-only compute, behind the same
        // sandbox policy as the agent, with the reviewer's database treated as private.
        const reviewerCompute = (await hostComputeProvider.create(ctx, {
            cwd: paths.publicHome,
            hostPolicy,
        })) as HostCompute;
        unwind.unshift(async () => await reviewerCompute.dispose(ctx));

        const readSecurity = async (path: string): Promise<string | undefined> => {
            try {
                return boundSecurityFileText(await readFile(path));
            } catch (error: unknown) {
                if (isMissingSecurityFileError(error)) return undefined;
                throw error;
            }
        };
        const auto = new AutoModule({
            storage: new AgentStorage({
                acquireLock: async () => {
                    try {
                        return await acquireHappyAgentStorageLock(paths.autoAgentLockPath);
                    } catch (error: unknown) {
                        throw new Error(
                            "Auto mode cannot start because the automatic permission reviewer " +
                                "store is already in use by another process.",
                            { cause: error },
                        );
                    }
                },
                database: review.database,
            }),
            providers,
            provider,
            models: [...models],
            workingDirectory: paths.publicHome,
            lifetimeContext: ctx,
            reviewerTools: (scope) => compute.computeModule.reviewerTools(scope, reviewerCompute),
            readGlobalSecurity: async () => await readSecurity(paths.securityPath),
            readProjectSecurity: async () =>
                await readSecurity(join(paths.publicHome, "AGENTS_SECURITY.md")),
            readAgentsMd: async (reviewCtx, agentId) =>
                await systemPrompt.readAgentsMdInstructions(reviewCtx, agentId),
        });
        unwind.unshift(async () => await auto.close(ctx));

        const permissions = new PermissionsModule({
            reviewer: auto.reviewer,
            reviewTimeoutMs: AUTO_PERMISSION_REVIEW_BUDGET_MS,
            // A decision belongs in the journal a client reads and in the conversation record a
            // person reads. Neither may break the decision itself.
            listener: {
                onEvent: async (listenerCtx, event) => {
                    await conversations
                        .recordAgentEvent(listenerCtx, event.agentId, "permission_event", event)
                        .catch((error: unknown) => {
                            listenerCtx.log.warn(
                                "This agent's permission history is now incomplete.",
                                { agentId: event.agentId, type: event.type },
                                error,
                            );
                        });
                    await events.record(listenerCtx, {
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

        // The catalogs and the service behind them need each other: a workspace reservation asks Git
        // which branches are taken, while the service reads and writes through these very modules
        // and is keyed by a root agent that does not exist until they are assembled. The catalogs
        // therefore reach the service through a box filled a few lines below, before anything can
        // serve a request, so a call arriving earlier is a composition bug rather than a state a
        // caller can be in.
        const host: { service?: ProjectWorkspaceService } = {};
        const hostService = (): ProjectWorkspaceService => {
            if (host.service === undefined) {
                throw new Error(
                    "Projects and workspaces were used before their host was composed.",
                );
            }
            return host.service;
        };
        const projects = new ProjectsModule({
            crossWorkspace: configuration.values.features.crossWorkspace,
            avatarAssetReader: {
                read: async (avatarCtx, agentId, hash) =>
                    await hostService().avatarAssetReader.read(avatarCtx, agentId, hash),
            },
        });
        const workspaces = new WorkspacesModule({
            // Removing a workspace's folder is the consequence of an archive that has already been
            // recorded, so it runs on the agent's own lifetime rather than on the request that
            // asked for it and would be gone before the folder is.
            cleanupContext: withDatabase(hostRoot.named("workspace-folder-cleanup")),
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
        });

        // Gemini is not one of the accounts a chat runs on, so its search reads a key from the
        // environment rather than from a configured provider.
        const gemini = process.env.GEMINI_API_KEY?.trim() || undefined;
        const modules: HappyAgentModules = {
            collaboration: new CollaborationModule(),
            compute: compute.computeModule,
            config,
            conversations,
            events,
            goal: new GoalModule({}),
            history,
            imageGeneration: new ImageGenerationModule({ config, providers }),
            modelSwitch: new ModelSwitchModule({ history }),
            observation,
            permissions,
            presence,
            projects,
            scheduling: new SchedulingModule(),
            search: new SearchModule({
                providers,
                models,
                currentProviderId: provider,
                bedrockSearchModels: bedrockSearchModels(configuration),
                ...(gemini === undefined ? {} : { geminiApiKey: gemini }),
            }),
            secrets: new SecretsModule({}),
            skills: compute.skillsModule,
            systemPrompt,
            tasks: new TasksModule({}),
            usage: new UsageModule({}),
            userInput: new UserInputModule({
                presence: presence.userInputPolicy,
                // Only a person's own answer becomes authorization evidence: the actor answering
                // must be the agent that asked. An agent answering for another agent is a
                // hand-off, not a human decision, and stays untrusted context.
                listener: {
                    onEventTransactional: async (listenerCtx, event) => {
                        if (event.type !== "user_input_answered") return;
                        if (event.actingAgentId !== event.request.askingAgentId) return;
                        await auto
                            .recordUserInputEventTransactional(listenerCtx, {
                                type: "user_input_answered",
                                agentId: event.request.askingAgentId,
                                requestId: event.requestId,
                                answer: JSON.stringify(
                                    event.request.answers ?? event.request.answer,
                                ),
                            })
                            // An unrecorded answer under-authorizes, which is the safe direction.
                            // It must never break saving what the person said.
                            .catch(() => undefined);
                    },
                    onEvent: async (listenerCtx, event) => {
                        await events
                            .record(listenerCtx, {
                                agentId: event.request.askingAgentId,
                                type: "user_input.event",
                                payload: event,
                            })
                            .catch((error: unknown) => {
                                listenerCtx.log.warn(
                                    "Failed to journal a user input event.",
                                    { agentId: event.request.askingAgentId, type: event.type },
                                    error,
                                );
                            });
                    },
                },
            }),
            workspaces,
        };

        // Order is dependency order: a module may rely on anything started before it. Permissions
        // precedes the reviewer's own archive, which observes the same hooks reviewed agents emit;
        // compute precedes events so a tool's effects are journaled after they exist.
        let installation: Installation | undefined;
        const ordered: AgentModule<AnyAgentTool, LibSQLDatabase>[] = [
            modules.config,
            modules.observation,
            modules.systemPrompt,
            modules.conversations,
            modules.history,
            modules.modelSwitch,
            modules.permissions,
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
            modules.search,
            modules.imageGeneration,
            modules.skills,
            modules.compute,
            modules.events,
            installationModule((found) => {
                installation = found;
            }),
        ].map(checkModuleToolParameters);

        const storage = new AgentStorage({
            acquireLock: async () => await acquireHappyAgentStorageLock(paths.agentLockPath),
            database: main.database,
        });
        const system = await AgentSystemLocal.create(ctx, storage, {
            models,
            modules: ordered,
            provider,
            providers,
        });
        unwind.unshift(async () => await system.close(ctx));
        if (installation === undefined) {
            throw new Error("The Happy agent identity was not established while starting.");
        }
        const rootAgentId = installation.rootAgentId;

        // The root agent is the conversation a person opens when they start Rig. It works in the
        // public home and nowhere else.
        const rootConfig = {
            environment: { ...currentAgentEnvironment(), workingDirectory: paths.publicHome },
            modules: { compute: { cwd: paths.publicHome, providerId: "host" } },
        };
        const existing = await system.config(ctx, rootAgentId);
        const agent =
            existing === undefined
                ? await system.create(ctx, rootConfig, { id: rootAgentId })
                : await system.resolve(ctx, rootAgentId);

        const projectWorkspaces = new ProjectWorkspaceService({
            agentId: rootAgentId,
            extendBackgroundContext: withDatabase,
            // One machine, one person: this installation is the instance, and the only profile it
            // can resolve is whoever this copy of Git commits as.
            localCreator: { instanceId: rootAgentId, profileId: LOCAL_PROJECT_PROFILE_ID },
            localInstanceId: rootAgentId,
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
            projects,
            resolveGitSecret: (kind) =>
                kind === "github" ? localGithubToken(process.env) : undefined,
            resolveProfile: async (profileId) =>
                profileId === LOCAL_PROJECT_PROFILE_ID
                    ? await localGitProfile(rootAgentId)
                    : undefined,
            rootContext: hostRoot,
            settings: configuration.values.workspace,
            // Avatar bytes are content a person chose and expects to survive a restart, so they
            // live beside the agent's own database rather than in a temporary folder.
            stateDirectory: join(paths.agentHome, "projects"),
            workspaces,
        });
        host.service = projectWorkspaces;

        // One watcher for the whole installation. Every reader that wants Git state registers here
        // and reads what the watcher already knows, instead of scanning repositories itself. What a
        // scan learns is written back through the catalogs, so a snapshot taken for one reader
        // becomes a durable fact for every later one.
        const gitTracker = new GitStateTracker({
            onObserverError: (_observerCtx, error, entity) => {
                ctx.log.debug("A Git watcher could not be armed.", { path: entity.path }, error);
            },
            onSnapshot: async (snapshotCtx, entity, snapshot) => {
                await projectWorkspaces.gitSnapshotObserver(
                    withDatabase(snapshotCtx),
                    entity,
                    snapshot,
                );
            },
            rootContext: hostRoot,
        });
        // The watcher and the project service stop before the systems that own their database: both
        // write through the catalogs from background lifetimes, and a write arriving after the
        // database closed is the one failure nobody would see.
        unwind.unshift(async () => {
            gitTracker.dispose();
            await projectWorkspaces.close(withDatabase(ctx));
        });
        await projectWorkspaces.open(withDatabase(ctx));

        return {
            agent,
            background,
            close,
            configuration,
            ctx,
            database: main.database,
            gitTracker,
            installation: {
                epoch: installation.epoch,
                schemaVersion: installation.schemaVersion,
            },
            models,
            modules,
            projectWorkspaces,
            provider,
            providers,
            storage,
            system,
        };
    } catch (error) {
        await close().catch(() => undefined);
        throw error;
    }
}

/** Bedrock serves its hosted search index from particular models, so an account may name its own. */
function bedrockSearchModels(configuration: HappyAgentConfiguration): Record<string, string> {
    const models: Record<string, string> = {};
    for (const [id, provider] of Object.entries(configuration.values.providers)) {
        if (provider.enabled === false || provider.type !== "bedrock") continue;
        if (provider.searchModelId !== undefined) models[id] = provider.searchModelId;
    }
    return models;
}

/**
 * The only profile a single-machine installation can resolve.
 *
 * Profiles are a multi-instance idea: a project created on one machine records who created it so
 * another machine can refuse to clone with the wrong person's credentials. One local installation
 * has exactly one person behind it, so it names that profile once and answers for it below.
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

interface Installation {
    readonly epoch: string;
    readonly rootAgentId: string;
    readonly schemaVersion: number;
}

/**
 * Remembers what this `.happy` folder is: which conversation is its root, and which installation it
 * has been since the first time anyone started here.
 *
 * It is a module so that it is created by the same migration pass as everything else.
 */
function installationModule(
    found: (installation: Installation) => void,
): AgentModule<AnyAgentTool, LibSQLDatabase> {
    return {
        name: "happy-agent-installation",
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
            found(await ctx.inTx(async (txCtx) => await readInstallation(txCtx.db)));
        },
    };
}

async function readInstallation(database: AgentDatabase): Promise<Installation> {
    const rows = await agentDatabaseRows<{ key: string; value: string }>(
        database,
        sql`SELECT key, value FROM happy_agent_loader_state
            WHERE key IN ('root_agent_id', 'installation_epoch', 'schema_version')`,
    );
    const values = new Map(rows.map((row) => [row.key, row.value]));
    const rootAgentId = values.get("root_agent_id") ?? createId();
    if (!/^[a-z][a-z0-9]+$/.test(rootAgentId)) {
        throw new Error("The stored root agent identity is invalid.");
    }
    const epoch = values.get("installation_epoch") ?? randomUUID();
    const storedVersion = values.get("schema_version");
    const schemaVersion = storedVersion === undefined ? 1 : Number.parseInt(storedVersion, 10);
    if (!Number.isSafeInteger(schemaVersion) || schemaVersion < 1) {
        throw new Error("The stored Happy agent schema version is invalid.");
    }
    for (const [key, value] of [
        ["root_agent_id", rootAgentId],
        ["installation_epoch", epoch],
        ["schema_version", String(schemaVersion)],
    ] as const) {
        if (values.has(key)) continue;
        await agentDatabaseRun(
            database,
            sql`INSERT INTO happy_agent_loader_state (key, value) VALUES (${key}, ${value})`,
        );
    }
    return { epoch, rootAgentId, schemaVersion };
}

type ConfiguredPresence = NonNullable<PresenceModuleOptions["catalog"]>[number];

/** The states every installation has, before the configuration adds to or retitles any of them. */
const BUILT_IN_PRESENCE: readonly ConfiguredPresence[] = [
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

function presenceOptions(
    configuration: HappyAgentConfiguration,
): ConstructorParameters<typeof PresenceModule>[0] {
    const presence = configuration.values.presence;
    const catalog: ConfiguredPresence[] = Object.entries(presence.states).map(([id, state]) => {
        const builtIn = BUILT_IN_PRESENCE.find((candidate) => candidate.id === id);
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
    const current = presence.current;
    if (current === undefined) {
        return { catalog } as unknown as ConstructorParameters<typeof PresenceModule>[0];
    }
    const known = new Set([
        ...BUILT_IN_PRESENCE.map((candidate) => candidate.id),
        ...Object.keys(presence.states),
    ]);
    if (!known.has(current)) {
        throw new Error(`Configured current presence "${current}" is not defined.`);
    }
    if (presence.fallback !== undefined && !known.has(presence.fallback)) {
        throw new Error(`Configured fallback presence "${presence.fallback}" is not defined.`);
    }
    return {
        catalog,
        initialState: {
            presenceId: current,
            ...(presence.fallback === undefined ? {} : { fallbackPresenceId: presence.fallback }),
            ...(presence.until === undefined ? {} : { expiresAt: presence.until }),
        },
    } as unknown as ConstructorParameters<typeof PresenceModule>[0];
}
