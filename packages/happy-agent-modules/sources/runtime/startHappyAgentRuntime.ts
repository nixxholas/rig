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
import { createRootContext, detach, type Context, type RootContext } from "@steve.kite/stdlib";
import type { LibSQLDatabase } from "drizzle-orm/libsql";

import { ApiModule } from "../api/index.js";
import { AutoModule } from "../auto/index.js";
import { CollaborationModule } from "../collaboration/index.js";
import { ComputeModule, createComputeModules, type HostCompute } from "../compute/index.js";
import { ConfigModule, type HappyAgentConfiguration } from "../config/index.js";
import { EventsModule } from "../events/index.js";
import { ProjectFilesModule } from "../files/index.js";
import { GitModule } from "../git/index.js";
import { GoalModule } from "../goal/index.js";
import { HappyModule } from "../happy/index.js";
import { HistoryModule } from "../history/index.js";
import { ImageGenerationModule } from "../imageGeneration/index.js";
import { ModelSwitchModule } from "../modelSwitch/ModelSwitchModule.js";
import { MurmurModule } from "../murmur/index.js";
import { ObservationModule } from "../observation/index.js";
import { PermissionsModule } from "../permissions/index.js";
import { PresenceModule } from "../presence/index.js";
import { ProfileModule } from "../profile/index.js";
import { ProjectsModule } from "../projects/index.js";
import { SchedulingModule } from "../scheduling/index.js";
import { SearchModule } from "../search/index.js";
import { SecretsModule } from "../secrets/index.js";
import { SkillsModule } from "../skills/index.js";
import { SystemPromptModule } from "../systemPrompt/index.js";
import { TasksModule } from "../tasks/index.js";
import { TerminalsModule } from "../terminals/index.js";
import { TitlesModule } from "../titles/index.js";
import { UsageModule } from "../usage/index.js";
import { UserInputModule } from "../userInput/index.js";
import { WorkflowsModule } from "../workflows/index.js";
import { WorkspacesModule } from "../workspaces/index.js";
import { checkModuleToolParameters } from "./checkModuleToolParameters.js";
import { openHappyAgentDatabase } from "./HappyAgentDatabase.js";
import { acquireHappyAgentStorageLock } from "./HappyAgentStorageLock.js";
import { InstallationModule } from "./InstallationModule.js";

/** The only runtime inputs not owned by configuration. Product startup supplies only version. */
export interface StartHappyAgentRuntimeOptions {
    /** Happy's private root. Defaults to `~/.happy`. */
    readonly happyHome?: string;
    /** Human-readable version this process reports. */
    readonly version?: string;
    /** Test-only inference replacement. */
    readonly inference?: {
        readonly models: readonly AgentModel[];
        readonly providers: AgentProviders;
    };
    /** Test-only machine replacement. */
    readonly compute?: (ctx: Context, config: HostComputeConfig) => Promise<Compute>;
    /** Test-owned environment overrides consumed only by the config module. */
    readonly environment?: Readonly<NodeJS.ProcessEnv>;
    /**
     * Called after the API exists but before agents restore.
     *
     * The executable binds its Unix socket here so health can report `starting` throughout the
     * AgentSystem startup pass. Runtime composition and ownership stay in this package.
     */
    readonly onPrepared?: (prepared: PreparedHappyAgentRuntime) => Promise<void> | void;
}

export interface PreparedHappyAgentRuntime {
    readonly api: ApiModule;
    readonly configuration: HappyAgentConfiguration;
    /** Create a database-scoped context for one independently owned socket operation. */
    context(name: string): Context;
}

/** Every capability in the runtime, addressable by its owning module. */
export interface HappyAgentRuntimeModules {
    readonly api: ApiModule;
    readonly auto: AutoModule;
    readonly collaboration: CollaborationModule;
    readonly compute: ComputeModule;
    readonly config: ConfigModule;
    readonly events: EventsModule;
    readonly files: ProjectFilesModule;
    readonly goal: GoalModule;
    readonly happy: HappyModule;
    readonly history: HistoryModule;
    readonly imageGeneration: ImageGenerationModule;
    readonly installation: InstallationModule;
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

export interface HappyAgentRuntime {
    readonly api: ApiModule;
    readonly ctx: RootContext;
    readonly configuration: HappyAgentConfiguration;
    readonly provider: string;
    readonly providers: AgentProviders;
    readonly models: readonly AgentModel[];
    readonly database: LibSQLDatabase;
    readonly storage: AgentStorage<LibSQLDatabase>;
    readonly system: AgentSystemLocal<LibSQLDatabase>;
    readonly modules: HappyAgentRuntimeModules;
    readonly git: GitModule;
    readonly installation: {
        readonly epoch: string;
        readonly schemaVersion: number;
    };
    readonly background: (name: string, work: (ctx: Context) => Promise<void>) => void;
    close(): Promise<void>;
}

/** Start the databases, modules, agent system, and API that make up one local Happy runtime. */
export async function startHappyAgentRuntime(
    options: StartHappyAgentRuntimeOptions = {},
): Promise<HappyAgentRuntime> {
    const config = await ConfigModule.load(options.happyHome, {
        ...(options.environment === undefined ? {} : { environment: options.environment }),
        ...(options.inference === undefined ? {} : { inference: options.inference }),
        ...(options.version === undefined ? {} : { version: options.version }),
    });
    const configuration = config.configuration;
    const paths = configuration.paths;
    const observation = await ObservationModule.start(config);
    const ctx = observation.install(createRootContext());
    const unwind: (() => Promise<void> | void)[] = [async () => await observation.close(ctx)];
    let closed = false;
    const backgroundTasks = new Set<Promise<void>>();
    const close = async (): Promise<void> => {
        if (closed) return;
        closed = true;
        const failures: unknown[] = [];
        while (backgroundTasks.size > 0) await Promise.allSettled(backgroundTasks);
        for (const step of unwind.splice(0)) {
            try {
                await step();
            } catch (error) {
                failures.push(error);
            }
        }
        if (failures.length > 0) {
            throw new AggregateError(failures, "The Happy agent runtime did not close cleanly.");
        }
    };

    try {
        await mkdir(paths.agentHome, { mode: 0o700, recursive: true });
        await chmod(paths.agentHome, 0o700);
        await mkdir(paths.publicHome, { mode: 0o755, recursive: true });
        await mkdir(paths.generatedPath, { mode: 0o755, recursive: true });

        const models = config.models;
        const provider = models[0]?.providerId;
        if (provider === undefined) throw new Error("No model is enabled by the configuration.");
        const providers = config.providers;
        if (providers.typeOf(provider) === null) {
            throw new Error(`The configured default provider "${provider}" is not enabled.`);
        }

        const main = await openHappyAgentDatabase(paths.databasePath);
        unwind.unshift(() => main.close());
        await chmod(paths.databasePath, 0o600);
        const review = await openHappyAgentDatabase(paths.autoDatabasePath);
        unwind.unshift(() => review.close());
        await chmod(paths.autoDatabasePath, 0o600);

        const runtimeRoot = detach(ctx);
        const withDatabase = (target: Context): Context => withAgentDatabase(target, main.database);
        const background = (name: string, work: (workerCtx: Context) => Promise<void>): void => {
            if (closed) return;
            const task = work(withDatabase(runtimeRoot.named(name)))
                .catch((error: unknown) => {
                    ctx.log.warn(`Background work "${name}" failed.`, {}, error);
                })
                .finally(() => {
                    backgroundTasks.delete(task);
                });
            backgroundTasks.add(task);
        };

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

        const events = new EventsModule();
        const history = new HistoryModule(events);
        history.onAppend(observation.recordHistory);
        const presence = new PresenceModule(config);
        const systemPrompt = new SystemPromptModule(config, compute.computeModule);
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
        const git = new GitModule();
        const projects = new ProjectsModule(config, git);
        const workspaces = new WorkspacesModule(config, projects, git);
        const titles = new TitlesModule(config, workspaces);
        const terminals = new TerminalsModule(projects, workspaces);
        unwind.unshift(async () => await terminals.close());
        const files = new ProjectFilesModule(projects, workspaces, git);

        const profile = new ProfileModule<LibSQLDatabase>();
        const murmur = new MurmurModule<LibSQLDatabase>(config, profile);
        const collaboration = new CollaborationModule();
        const scheduling = new SchedulingModule();
        const userInput = new UserInputModule(presence);
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
                .catch(() => undefined);
        });

        const installation = new InstallationModule();
        const happy = new HappyModule(
            config,
            events,
            history,
            projects,
            scheduling,
            userInput,
            workspaces,
        );
        const goal = new GoalModule();
        const imageGeneration = new ImageGenerationModule(config);
        const modelSwitch = new ModelSwitchModule(history);
        const search = new SearchModule(config);
        const secrets = new SecretsModule();
        const tasks = new TasksModule();
        const usage = new UsageModule(events);
        const workflows = new WorkflowsModule(config, collaboration, compute.computeModule);
        const api = new ApiModule(
            config,
            events,
            projects,
            workspaces,
            terminals,
            files,
            git,
            history,
            userInput,
            usage,
            profile,
            compute.computeModule,
        );
        unwind.unshift(async () => await api.close());

        const modules: HappyAgentRuntimeModules = {
            api,
            auto,
            collaboration,
            compute: compute.computeModule,
            config,
            events,
            files,
            goal,
            happy,
            history,
            imageGeneration,
            installation,
            modelSwitch,
            murmur,
            observation,
            permissions,
            presence,
            profile,
            projects,
            scheduling,
            search,
            secrets,
            skills: compute.skillsModule,
            systemPrompt,
            tasks,
            terminals,
            titles,
            usage,
            userInput,
            workflows,
            workspaces,
        };

        const ordered: AgentModule<AnyAgentTool, LibSQLDatabase>[] = [
            // API must subscribe before any later module restores state or emits an event.
            api,
            config,
            observation,
            systemPrompt,
            history,
            modelSwitch,
            permissions,
            auto,
            presence,
            goal,
            tasks,
            usage,
            profile,
            murmur,
            git,
            projects,
            titles,
            workspaces,
            secrets,
            collaboration,
            workflows,
            scheduling,
            userInput,
            search,
            imageGeneration,
            compute.skillsModule,
            compute.computeModule,
            events,
            happy,
            installation,
        ].map(checkModuleToolParameters);

        await api.prepare();
        await options.onPrepared?.({
            api,
            configuration,
            context: (name) => withDatabase(ctx.named(name)),
        });

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
        unwind.unshift(async () => await happy.stop());

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
        unwind.unshift(async () => {
            git.dispose();
            await workspaces.close(withDatabase(ctx));
            await projects.close(withDatabase(ctx));
        });
        await projects.open(withDatabase(ctx), installation.epoch);
        await workspaces.open(withDatabase(ctx));

        profile.open(installation.epoch);
        unwind.unshift(async () => await murmur.close(withDatabase(ctx)));
        const person = await profile.get(withDatabase(ctx));
        await murmur.open(
            withDatabase(ctx),
            ...(person === undefined ? [] : ([person.id] as const)),
        );

        await api.markReady();

        return {
            api,
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
