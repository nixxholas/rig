import { chmod, mkdir } from "node:fs/promises";

import {
    AgentStorage,
    AgentSystemLocal,
    withAgentDatabase,
    type AgentModel,
    type AgentModule,
    type AgentProviders,
    type AnyAgentTool,
} from "@slopus/happy-agent-base";
import type { Compute, HostComputeConfig } from "@slopus/happy-agent-compute";
import {
    AutoModule,
    CollaborationModule,
    ComputeModule,
    ConfigModule,
    EventsModule,
    GitModule,
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
    TitlesModule,
    UsageModule,
    UserInputModule,
    WorkflowsModule,
    WorkspacesModule,
    createComputeModules,
    type HappyAgentConfiguration,
    type HostCompute,
} from "@slopus/happy-agent-modules";
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import { createRootContext, detach, type Context, type RootContext } from "@steve.kite/stdlib";

import { checkModuleToolParameters } from "../modules/agent/checkModuleToolParameters.js";
import { openHappyAgentDatabase } from "../modules/agent/HappyAgentDatabase.js";
import { acquireHappyAgentStorageLock } from "../modules/agent/HappyAgentStorageLock.js";
import { ConversationModule } from "../modules/conversations/ConversationModule.js";
import { HappyModule } from "../modules/happy/index.js";
import { InstallationModule } from "../modules/installation/InstallationModule.js";

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
    readonly happy: HappyModule;
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
    readonly titles: TitlesModule;
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
    readonly modules: HappyAgentModules;
    /**
     * Git itself: the one instance every reader shares, holding the live watcher and the
     * credentials the catalogs registered, instead of scanning once per request.
     */
    readonly git: GitModule;
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
    const config = await ConfigModule.load(options.happyHome, {
        ...(options.inference === undefined ? {} : { inference: options.inference }),
        ...(options.version === undefined ? {} : { version: options.version }),
    });
    const configuration = config.configuration;
    const paths = configuration.paths;
    // Observation starts before anything it should be able to watch, and the root it installs its
    // logger and tracer on becomes the root every lifetime below is derived from. Contexts are
    // immutable, so a module started on the bare root would log nowhere for ever.
    const observation = await ObservationModule.start(config);
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

        // The catalog puts the configured default first, so the account serving it is the one every
        // agent starts on. Nothing else in the agent decides what a turn runs on: a caller names
        // that with the message it sends.
        const models = config.models;
        const provider = models[0]?.providerId;
        if (provider === undefined) throw new Error("No model is enabled by the configuration.");
        const providers = config.providers;
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

        // The compute module derives its own host policy from the configuration. A caller that
        // supplies its own machine — a test, or a deployment that runs the agent in a container —
        // replaces only how one is created, which is the one thing configuration cannot know.
        const suppliedCompute = options.compute;
        const computeModule =
            suppliedCompute === undefined
                ? new ComputeModule(config)
                : ComputeModule.withProvider(config, {
                      id: "host",
                      create: async (computeCtx: Context, computeConfig: HostComputeConfig) =>
                          (await suppliedCompute(computeCtx, computeConfig)) as HostCompute,
                  });
        const compute = createComputeModules(computeModule);
        unwind.unshift(async () => await compute.computeModule.dispose(ctx));

        const history = new HistoryModule();
        // The history dump follows the archive by subscription, so it is wired after both modules
        // exist rather than being built into one of them.
        history.onAppend(observation.recordHistory);
        const events = new EventsModule();
        const presence = new PresenceModule(config);

        // The system prompt reads each agent's own AGENTS.md through that agent's compute, so the
        // reviewer below sees exactly the project instructions the reviewed agent sees.
        const systemPrompt = new SystemPromptModule(config, compute.computeModule);

        // The reviewer runs on its own private database, its own accounts and its own read-only
        // compute. Only the store is handed in: this package is what opens databases.
        const auto = new AutoModule(
            config,
            compute.computeModule,
            systemPrompt,
            new AgentStorage({
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
        );
        unwind.unshift(async () => await auto.close(ctx));

        const permissions = new PermissionsModule(compute.computeModule, auto);
        // A decision belongs in the journal a client reads and in the conversation record a person
        // reads. Neither may break the decision itself.
        permissions.onEvent(async (listenerCtx, event) => {
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
        });

        // Cutting a worktree, cloning a repository, running setup commands and removing a folder are
        // all consequences of a decision that has already been recorded, so the catalogs run them on
        // the agent's own lifetime rather than on the request that asked and would be gone before
        // they finish. `withDatabase` keeps the root a root; the cast only restates that.
        const catalogRoot = withDatabase(hostRoot) as RootContext;
        // Git is one module for the whole installation: it runs every command, brokers every
        // repository credential and holds the one live watcher. Both catalogs and the daemon's
        // routes take this instance, so a credential registered by one is visible to all of them.
        const git = new GitModule();
        // The workspaces catalog is cut from the projects catalog: a workspace is a branch of a
        // project's repository, in a folder under the project's own key, and the project owns the
        // repository lock both of them take. That makes the dependency one-way, and the projects
        // catalog is built first so it can be handed over rather than reached for.
        const projects = new ProjectsModule(config, git);
        const workspaces = new WorkspacesModule(config, projects, git);

        // What a first message names: the chat, and the workspace and branch it works in. Naming is
        // one bounded question asked of the cheapest model of the chat's own account, so it owns the
        // whole thing — it takes the accounts from the configuration and hands the folder name to
        // the catalog that owns folders and branches.
        const titles = new TitlesModule(config, workspaces);

        // The chat catalog is what a title is written into, so it is what looks at one again once a
        // run has settled and the conversation says more than the first message could.
        const conversations = new ConversationModule({
            defaultCwd: paths.publicHome,
            events,
            history,
            rootContext: catalogRoot,
            titles,
        });
        unwind.unshift(async () => await conversations.whenTitlesSettle());

        // Terminals stand in the folders both catalogs own, so they ask those catalogs where a
        // project or workspace actually is rather than deriving a path of their own. They keep no
        // record: a terminal is a running process and a live screen, and both end with this daemon.
        const terminals = new TerminalsModule(projects, workspaces);
        unwind.unshift(async () => await terminals.close());

        // One person behind this installation, and the contacts they have accepted. Sharing is
        // given the profile catalog itself, because whether this installation may act as that
        // person is that catalog's decision rather than something to restate here.
        const profile = new ProfileModule<LibSQLDatabase>();
        profile.onEvent(async (listenerCtx, event) => {
            await events.record(listenerCtx, { type: "profile.changed", payload: event });
        });
        const murmur = new MurmurModule<LibSQLDatabase>(config, profile);
        // Murmur names its own event; sharing is what a client calls it, and the client's name is
        // what goes on the wire.
        murmur.onEvent((listenerCtx, event) => {
            void events
                .record(listenerCtx, {
                    type: "sharing.changed",
                    payload: { ...event, type: "sharing_changed" },
                })
                .catch((error: unknown) => {
                    listenerCtx.log.warn("A sharing change was not journaled.", {}, error);
                });
        });

        // A workflow starts its agents through collaboration, so it needs that very module rather
        // than one of its own.
        const collaboration = new CollaborationModule();

        // Journaling a question and its answer happens after the transaction that saved them has
        // committed, so it cannot run on that transaction's context: writing needs a transaction of
        // its own. This lifetime is the daemon's, not the asking turn's.
        const userInputJournal = withDatabase(hostRoot.named("user-input-journal"));
        const scheduling = new SchedulingModule();
        const userInput = new UserInputModule(presence);
        // Only a person's own answer becomes authorization evidence: the actor answering must be
        // the agent that asked. An agent answering for another agent is a hand-off, not a human
        // decision, and stays untrusted context.
        userInput.onEventTransactional(async (listenerCtx, event) => {
            if (event.type !== "user_input_answered") return;
            if (event.actingAgentId !== event.request.askingAgentId) return;
            await auto
                .recordUserInputEventTransactional(listenerCtx, {
                    type: "user_input_answered",
                    agentId: event.request.askingAgentId,
                    requestId: event.requestId,
                    answer: JSON.stringify(event.request.answers ?? event.request.answer),
                })
                // An unrecorded answer under-authorizes, which is the safe direction. It must
                // never break saving what the person said.
                .catch(() => undefined);
        });
        userInput.onEvent(async (_listenerCtx, event) => {
            await events
                .record(userInputJournal, {
                    agentId: event.request.askingAgentId,
                    // Hyphens, not underscores: the journal only accepts dotted, hyphenated type
                    // names, so an underscored one is never stored.
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
        });
        // Happy is built here rather than beside the other modules because it works through them:
        // the configuration that says where the credentials live and what version to report, the
        // installation that knows which agent this machine acts as, the conversation catalog, the
        // journal it also projects, the questions a person answers on their phone, and the folders
        // a session may be started in. Nothing about talking to Happy is decided here.
        const installation = new InstallationModule();
        const happy = new HappyModule({
            config,
            conversations,
            events,
            scheduling,
            userInput,
            workspaces,
        });
        const modules: HappyAgentModules = {
            collaboration,
            compute: compute.computeModule,
            config,
            conversations,
            events,
            goal: new GoalModule(),
            happy,
            history,
            imageGeneration: new ImageGenerationModule(config),
            modelSwitch: new ModelSwitchModule(history),
            murmur,
            observation,
            permissions,
            presence,
            profile,
            projects,
            scheduling,
            search: new SearchModule(config),
            secrets: new SecretsModule(),
            skills: compute.skillsModule,
            systemPrompt,
            tasks: new TasksModule(),
            terminals,
            titles,
            usage: new UsageModule(),
            userInput,
            workflows: new WorkflowsModule(config, collaboration, compute.computeModule),
            workspaces,
        };

        // Order is dependency order: a module may rely on anything started before it. Permissions
        // precedes the reviewer's own archive, which observes the same hooks reviewed agents emit;
        // compute precedes events so a tool's effects are journaled after they exist.
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
            // Git declares no tools; its start hook adopts the collection's lifetime so watchers
            // and background scans do not run on a root of their own.
            git,
            modules.projects,
            // Titles precedes the catalog it names for: the workspace it renames is the one the
            // catalog owns, and the fact that a workspace has been named lives in this module.
            modules.titles,
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
            // Happy declares no tools and no beforeStart; it is here so its own sync migrations run
            // in the same pass as every other module's, and it is connected to the phone later.
            modules.happy,
            installation,
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

        // Happy connected itself as the collection started. It writes through the agent database,
        // so it stops before that database closes.
        unwind.unshift(async () => await happy.stop());

        // One watcher for the whole installation. Every reader that wants Git state registers here
        // and reads what the watcher already knows, instead of scanning repositories itself. What a
        // scan learns is written back through the catalogs, so a snapshot taken for one reader
        // becomes a durable fact for every later one. Failures are logged rather than raised: a scan
        // arriving for a workspace that has just been archived is ordinary, and a watcher is not the
        // place to decide a person sees an error.
        git.onSnapshot(async (snapshotCtx, entity, snapshot) => {
            const factsCtx = withDatabase(snapshotCtx);
            try {
                if (entity.workspaceId === undefined) {
                    await projects.recordGitFacts(factsCtx, entity.projectId, snapshot.facts);
                } else {
                    await workspaces.recordGitFacts(factsCtx, entity.workspaceId, snapshot.facts);
                }
            } catch (error: unknown) {
                factsCtx.log.debug(
                    "Git facts from a live scan were not stored.",
                    { path: entity.path },
                    error,
                );
            }
        });
        // The watcher and both catalogs stop before the systems that own their database: all three
        // write from background lifetimes, and a write arriving after the database closed is the one
        // failure nobody would see. Workspaces close before the projects they are cut from.
        unwind.unshift(async () => {
            git.dispose();
            await workspaces.close(withDatabase(ctx));
            await projects.close(withDatabase(ctx));
        });
        // The catalogs pick up whatever the last run left unfinished, and learn which machine they
        // are from the installation they are opened for.
        await projects.open(withDatabase(ctx), installation.epoch);
        await workspaces.open(withDatabase(ctx));

        // Sharing is the same machine as everything else here, and it reconnects to the relay only
        // when the configuration enabled it and a person has already been named. Its client holds a
        // socket, so it stops before the database it reads the binding from.
        profile.open(installation.epoch);
        unwind.unshift(async () => await murmur.close(withDatabase(ctx)));
        const person = await profile.get(withDatabase(ctx));
        await murmur.open(
            withDatabase(ctx),
            ...(person === undefined ? [] : ([person.id] as const)),
        );

        return {
            background,
            close,
            configuration,
            ctx,
            database: main.database,
            git,
            installation: {
                epoch: installation.epoch,
                schemaVersion: installation.schemaVersion,
            },
            models,
            modules,
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
