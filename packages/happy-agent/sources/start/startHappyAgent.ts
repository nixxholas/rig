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
import {
    hostComputeProvider,
    type Compute,
    type HostComputeConfig,
} from "@slopus/happy-agent-compute";
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
    MurmurModule,
    ObservationModule,
    PermissionsModule,
    PresenceModule,
    ProfileModule,
    ProjectsModule,
    SchedulingModule,
    SearchModule,
    SecretsModule,
    SkillsModule,
    SystemPromptModule,
    TasksModule,
    TerminalsModule,
    UsageModule,
    UserInputModule,
    WorkflowsModule,
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
import { GitStateTracker, directGitCommandRunner } from "@slopus/happy-agent-modules";
import type { ProjectCreatorProfile } from "@slopus/happy-agent-modules";

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
    /**
     * Replaces the machine every agent and the permission reviewer work on.
     *
     * This exists so a test can run the whole agent without handing it this computer. Nothing in
     * the product supplies it: a started agent works on the host, and everything else about
     * starting stays exactly the same.
     */
    readonly compute?: (ctx: Context, config: HostComputeConfig) => Promise<Compute>;
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
    readonly murmur: MurmurModule<LibSQLDatabase>;
    readonly observation: ObservationModule;
    readonly permissions: PermissionsModule;
    readonly presence: PresenceModule;
    readonly profile: ProfileModule<LibSQLDatabase>;
    readonly projects: ProjectsModule;
    readonly scheduling: SchedulingModule;
    readonly search: SearchModule;
    readonly secrets: SecretsModule;
    readonly skills: SkillsModule;
    readonly systemPrompt: SystemPromptModule;
    readonly tasks: TasksModule;
    readonly terminals: TerminalsModule;
    readonly usage: UsageModule;
    readonly userInput: UserInputModule;
    readonly workflows: WorkflowsModule;
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
    /** The agent this installation acts as, and the identity both catalogs were opened for. */
    readonly rootAgentId: string;
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

        const createCompute =
            options.compute ??
            (async (computeCtx: Context, computeConfig: HostComputeConfig) =>
                await hostComputeProvider.create(computeCtx, computeConfig));
        const compute = createComputeModules({
            provider: {
                id: "host",
                create: async (computeCtx, computeConfig) =>
                    (await createCompute(computeCtx, {
                        ...computeConfig,
                        hostPolicy,
                    })) as HostCompute,
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
        const reviewerCompute = (await createCompute(ctx, {
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

        // Cutting a worktree, cloning a repository, running setup commands and removing a folder are
        // all consequences of a decision that has already been recorded, so the catalogs run them on
        // the agent's own lifetime rather than on the request that asked and would be gone before
        // they finish. `withDatabase` keeps the root a root; the cast only restates that.
        const catalogRoot = withDatabase(hostRoot) as RootContext;
        // The workspaces catalog is cut from the projects catalog: a workspace is a branch of a
        // project's repository, in a folder under the project's own key, and the project owns the
        // repository lock both of them take. That makes the dependency one-way, and the projects
        // catalog is built first so it can be handed over rather than reached for.
        const projects = new ProjectsModule({
            crossWorkspace: configuration.values.features.crossWorkspace,
            rootContext: catalogRoot,
            // A project's own person: the profile this copy of Git commits as. Which machine that is
            // the catalog learns when it is opened, so only the profile is named here.
            localProfileId: LOCAL_PROJECT_PROFILE_ID,
            resolveGitSecret: (kind) =>
                kind === "github" ? localGithubToken(process.env) : undefined,
            resolveProfile: async (profileId, instanceId) =>
                profileId === LOCAL_PROJECT_PROFILE_ID
                    ? await localGitProfile(instanceId)
                    : undefined,
            // Avatar bytes are content a person chose and expects to survive a restart, so they
            // live beside the agent's own database rather than in a temporary folder.
            stateDirectory: join(paths.agentHome, "projects"),
            onHostError: (hostCtx, projectId, error) => {
                hostCtx.log.warn(
                    "Setting a project up failed; the record says so and it will be tried again.",
                    { projectId },
                    error,
                );
            },
        });
        const workspaces = new WorkspacesModule({
            enabled: configuration.values.features.workspaces,
            projects,
            rootContext: catalogRoot,
            settings: configuration.values.workspace,
            onHostError: (hostCtx, workspaceId, kind, message) => {
                hostCtx.log.warn(
                    kind === "archive"
                        ? "Removing an archived workspace folder failed; it stays archived and on disk."
                        : "Renaming a workspace branch failed; the record and Git now disagree.",
                    { workspaceId, message },
                );
            },
        });

        // Terminals stand in the folders both catalogs own, so they ask those catalogs where a
        // project or workspace actually is rather than deriving a path of their own. They keep no
        // record: a terminal is a running process and a live screen, and both end with this daemon.
        const terminals = new TerminalsModule({ projects, workspaces });
        unwind.unshift(async () => await terminals.close());

        // One person behind this installation, and the contacts they have accepted. Sharing is
        // given the profile catalog itself, because whether this installation may act as that
        // person is that catalog's decision rather than something to restate here.
        const profile = new ProfileModule<LibSQLDatabase>({
            listener: {
                onEvent: async (listenerCtx, event) => {
                    await events.record(listenerCtx, { type: "profile.changed", payload: event });
                },
            },
        });
        const sharing = configuration.values.sharing;
        const murmur = new MurmurModule<LibSQLDatabase>({
            enabled: sharing.enabled,
            listener: {
                onEvent: async (listenerCtx, event) => {
                    // Murmur names its own event; sharing is what a client calls it, and the
                    // client's name is what goes on the wire.
                    await events.record(listenerCtx, {
                        type: "sharing.changed",
                        payload: { ...event, type: "sharing_changed" },
                    });
                },
            },
            profile,
            relay: sharing.relayUrl,
            // The relay connection and the store both outlive every request that touches them, so
            // they run on the same application root the catalogs use, with the database attached.
            rootContext: catalogRoot,
            onError: (error: unknown) => {
                ctx.log.warn("Sharing could not reach the relay.", {}, error);
            },
        });

        // Gemini is not one of the accounts a chat runs on, so its search reads a key from the
        // environment rather than from a configured provider.
        const gemini = process.env.GEMINI_API_KEY?.trim() || undefined;

        // A workflow starts its agents through collaboration, so it needs that very module rather
        // than one of its own.
        const collaboration = new CollaborationModule();

        // Journaling a question and its answer happens after the transaction that saved them has
        // committed, so it cannot run on that transaction's context: writing needs a transaction of
        // its own. This lifetime is the daemon's, not the asking turn's.
        const userInputJournal = withDatabase(hostRoot.named("user-input-journal"));
        const modules: HappyAgentModules = {
            collaboration,
            compute: compute.computeModule,
            config,
            conversations,
            events,
            goal: new GoalModule({}),
            history,
            imageGeneration: new ImageGenerationModule({ config, providers }),
            modelSwitch: new ModelSwitchModule({ history }),
            murmur,
            observation,
            permissions,
            presence,
            profile,
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
            terminals,
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
                    onEvent: async (_listenerCtx, event) => {
                        await events
                            .record(userInputJournal, {
                                agentId: event.request.askingAgentId,
                                // Hyphens, not underscores: the journal only accepts dotted,
                                // hyphenated type names, so an underscored one is never stored.
                                type: "user-input.event",
                                payload: event,
                            })
                            .catch((error: unknown) => {
                                userInputJournal.log.warn(
                                    "Failed to journal a user input event.",
                                    { agentId: event.request.askingAgentId, type: event.type },
                                    error,
                                );
                            });
                    },
                },
            }),
            workflows: new WorkflowsModule({
                enabled: configuration.values.features.workflows,
                collaboration,
                compute: {
                    resolve: async (resolveCtx, agentId) =>
                        await compute.computeModule.resolve(resolveCtx, agentId),
                },
                // A run outlives the tool call that started it, so it lives on the application root
                // rather than on the turn that launched it, with the database attached.
                runContext: withDatabase(hostRoot.named("workflow-run")),
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
            modules.profile,
            // Sharing puts the profile on the wire, so the person exists before the identity does.
            modules.murmur,
            modules.projects,
            modules.workspaces,
            modules.secrets,
            modules.collaboration,
            // Workflows start their agents through collaboration, so collaboration comes first.
            modules.workflows,
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

        // One watcher for the whole installation. Every reader that wants Git state registers here
        // and reads what the watcher already knows, instead of scanning repositories itself. What a
        // scan learns is written back through the catalogs, so a snapshot taken for one reader
        // becomes a durable fact for every later one. Failures are logged rather than raised: a scan
        // arriving for a workspace that has just been archived is ordinary, and a watcher is not the
        // place to decide a person sees an error.
        const gitTracker = new GitStateTracker({
            onObserverError: (_observerCtx, error, entity) => {
                ctx.log.debug("A Git watcher could not be armed.", { path: entity.path }, error);
            },
            onSnapshot: async (snapshotCtx, entity, snapshot) => {
                const factsCtx = withDatabase(snapshotCtx);
                try {
                    if (entity.workspaceId === undefined) {
                        await projects.recordGitFacts(
                            factsCtx,
                            rootAgentId,
                            entity.projectId,
                            snapshot.facts,
                        );
                    } else {
                        await workspaces.recordGitFacts(
                            factsCtx,
                            rootAgentId,
                            entity.workspaceId,
                            snapshot.facts,
                        );
                    }
                } catch (error: unknown) {
                    factsCtx.log.debug(
                        "Git facts from a live scan were not stored.",
                        { path: entity.path },
                        error,
                    );
                }
            },
            rootContext: hostRoot,
        });
        // The watcher and both catalogs stop before the systems that own their database: all three
        // write from background lifetimes, and a write arriving after the database closed is the one
        // failure nobody would see. Workspaces close before the projects they are cut from.
        unwind.unshift(async () => {
            gitTracker.dispose();
            await workspaces.close(withDatabase(ctx));
            await projects.close(withDatabase(ctx));
        });
        // The catalogs pick up whatever the last run left unfinished, and learn which machine they
        // are from the agent they are opened for.
        await projects.open(withDatabase(ctx), rootAgentId);
        await workspaces.open(withDatabase(ctx), rootAgentId);

        // Sharing is the same machine as everything else here, and it reconnects to the relay only
        // when the configuration enabled it and a person has already been named. Its client holds a
        // socket, so it stops before the database it reads the binding from.
        profile.open(rootAgentId);
        unwind.unshift(async () => await murmur.close(withDatabase(ctx)));
        const person = await profile.get(withDatabase(ctx));
        await murmur.open(
            withDatabase(ctx),
            ...(person === undefined ? [] : ([person.id] as const)),
        );

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
            rootAgentId,
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
