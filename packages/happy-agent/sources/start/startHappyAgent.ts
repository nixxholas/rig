import { chmod, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { createId } from "@paralleldrive/cuid2";
import {
    AgentStorage,
    AgentSystemLocal,
    agentDatabaseRows,
    agentDatabaseRun,
    currentAgentEnvironment,
    type Agent,
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
    ModelSwitchModule,
    ObservationModule,
    PermissionsModule,
    PresenceModule,
    SchedulingModule,
    SearchModule,
    SecretsModule,
    SkillsModule,
    SystemPromptModule,
    TasksModule,
    UsageModule,
    UserInputModule,
    boundSecurityFileText,
    createComputeModules,
    isMissingSecurityFileError,
    type HappyAgentConfiguration,
    type HostCompute,
} from "@slopus/happy-agent-modules";
import { sql } from "drizzle-orm";
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import { createRootContext, type RootContext } from "@steve.kite/stdlib";

import { agentModels, agentProviders, defaultAgentProvider } from "./agentCatalog.js";
import { checkModuleToolParameters } from "../modules/agent/checkModuleToolParameters.js";
import { openHappyAgentDatabase } from "../modules/agent/HappyAgentDatabase.js";
import { acquireHappyAgentStorageLock } from "../modules/agent/HappyAgentStorageLock.js";
import { readGlobalInstructions } from "../modules/agent/readGlobalInstructions.js";
import { ConversationModule } from "../modules/conversations/ConversationModule.js";

/** Everything a caller needs to say. Every other answer comes out of the configuration. */
export interface StartHappyAgentOptions {
    /** Happy's private root. Defaults to `~/.happy`. */
    readonly happyHome?: string;
    /** Human-readable version this process reports. */
    readonly version?: string;
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
    readonly modelSwitch: ModelSwitchModule;
    readonly observation: ObservationModule;
    readonly permissions: PermissionsModule;
    readonly presence: PresenceModule;
    readonly scheduling: SchedulingModule;
    readonly search: SearchModule;
    readonly secrets: SecretsModule;
    readonly skills: SkillsModule;
    readonly systemPrompt: SystemPromptModule;
    readonly tasks: TasksModule;
    readonly usage: UsageModule;
    readonly userInput: UserInputModule;
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
    const observation = await ObservationModule.start({
        configuration,
        ...(options.version === undefined ? {} : { version: options.version }),
    });
    const ctx = observation.install(createRootContext());

    // The private root holds credentials and databases; the public home is the folder the agent
    // works in and a person may open.
    await mkdir(paths.agentHome, { mode: 0o700, recursive: true });
    await chmod(paths.agentHome, 0o700);
    await mkdir(paths.publicHome, { mode: 0o755, recursive: true });
    await mkdir(paths.generatedPath, { mode: 0o755, recursive: true });

    const models = agentModels(configuration);
    const provider = defaultAgentProvider(configuration);
    const providers = agentProviders(configuration);
    if (providers.typeOf(provider) === null) {
        throw new Error(`The configured default provider "${provider}" is not enabled.`);
    }

    // Two databases: the agent's own, and the reviewer's. A permission review must never read or
    // write the state of the agent it is reviewing, so they share neither file nor lock.
    const main = await openHappyAgentDatabase(paths.databasePath);
    await chmod(paths.databasePath, 0o600);
    const review = await openHappyAgentDatabase(paths.autoDatabasePath);
    await chmod(paths.autoDatabasePath, 0o600);
    const unwind: (() => Promise<void> | void)[] = [() => review.close(), () => main.close()];
    const close = async (): Promise<void> => {
        const failures: unknown[] = [];
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
        const protectedProjectFiles = [
            ...new Set([
                "AGENTS.md",
                "AGENTS_SECURITY.md",
                ...configuration.values.permissions.protectedPaths,
                ...configuration.values.workspace.protectedSync,
            ]),
        ];
        const hostPolicy = { privateDirectories: [paths.agentHome], protectedProjectFiles };

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
        const presence = new PresenceModule({});

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
                acquireLock: async () =>
                    await acquireHappyAgentStorageLock(paths.autoAgentLockPath),
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

        const modules: HappyAgentModules = {
            collaboration: new CollaborationModule(),
            compute: compute.computeModule,
            config,
            conversations,
            events,
            goal: new GoalModule({}),
            history,
            modelSwitch: new ModelSwitchModule({ history }),
            observation,
            permissions,
            presence,
            scheduling: new SchedulingModule(),
            search: new SearchModule({
                providers,
                models,
                currentProviderId: provider,
                bedrockSearchModels: bedrockSearchModels(configuration),
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
        };

        // Order is dependency order: a module may rely on anything started before it. Permissions
        // precedes the reviewer's own archive, which observes the same hooks reviewed agents emit;
        // compute precedes events so a tool's effects are journaled after they exist.
        let rootAgentId: string | undefined;
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
            modules.secrets,
            modules.collaboration,
            modules.scheduling,
            modules.userInput,
            modules.search,
            modules.skills,
            modules.compute,
            modules.events,
            identityModule((id) => {
                rootAgentId = id;
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
        if (rootAgentId === undefined) {
            throw new Error("The Happy agent identity was not established while starting.");
        }

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

        return {
            agent,
            close,
            configuration,
            ctx,
            database: main.database,
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
 * Remembers which agent this installation's root conversation is.
 *
 * It is a module so that it is created by the same migration pass as everything else, and it reads
 * the row the existing loader writes, so one `.happy` folder names the same root agent either way.
 */
function identityModule(
    found: (rootAgentId: string) => void,
): AgentModule<AnyAgentTool, LibSQLDatabase> {
    return {
        name: "happy-agent-identity",
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
            found(
                await ctx.inTx(async (txCtx) => {
                    const rows = await agentDatabaseRows<{ value: string }>(
                        txCtx.db,
                        sql`SELECT value FROM happy_agent_loader_state WHERE key = 'root_agent_id'`,
                    );
                    const stored = rows[0]?.value;
                    if (stored !== undefined) return stored;
                    const created = createId();
                    await agentDatabaseRun(
                        txCtx.db,
                        sql`INSERT INTO happy_agent_loader_state (key, value)
                            VALUES ('root_agent_id', ${created})`,
                    );
                    return created;
                }),
            );
        },
    };
}
