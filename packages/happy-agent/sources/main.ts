import { withAgentDatabase } from "@slopus/happy-agent-base";
import type { Context, RootContext } from "@steve.kite/stdlib";

import {
    loadHappyAgent,
    type LoadedHappyAgent,
    type LoadHappyAgentOptions,
} from "./modules/agent/loadHappyAgent.js";
import {
    applyEffectiveAgentSelection,
    createVanillaHappyAgentConfiguration,
    resolveEffectiveAgentSelection,
} from "./vanillaHappyAgentConfiguration.js";
import {
    startAgentHttpServer,
    type AgentHttpConfiguration,
    type AgentHttpRouteGroup,
    type AgentHttpServer,
} from "./modules/http/index.js";
import {
    ConfigModule,
    ObservationModule,
    type HappyAgentConfiguration,
} from "@slopus/happy-agent-modules";

export interface StartHappyAgentDaemonOptions extends Omit<
    LoadHappyAgentOptions,
    | "configModule"
    | "configuration"
    | "effectiveSelection"
    | "integrations"
    | "models"
    | "observation"
    | "provider"
    | "providers"
> {
    /** Happy's private root. Defaults to `~/.happy`. */
    readonly happyHome?: string;
    /** Override the standard host integrations. */
    readonly integrations?: LoadHappyAgentOptions["integrations"];
    /** Override the standard curated model catalog. */
    readonly models?: LoadHappyAgentOptions["models"];
    /** Override the standard default provider. */
    readonly provider?: LoadHappyAgentOptions["provider"];
    /** Override the configured default model. */
    readonly model?: string;
    /** Override the configured default reasoning effort. */
    readonly effort?: string;
    /** Override the configured default service tier. */
    readonly serviceTier?: "fast" | "priority" | null;
    /** Override the standard provider registry. */
    readonly providers?: LoadHappyAgentOptions["providers"];
    /** Optional host-backed daemon configuration and inspector capabilities. */
    readonly httpConfiguration?: AgentHttpConfiguration;
    /** Additional route families registered by the composition root. */
    readonly routeGroups?: readonly AgentHttpRouteGroup[];
    /** Human-readable daemon version exposed by health/installation. */
    readonly version?: string;
}

export interface HappyAgentDaemon {
    readonly agent: LoadedHappyAgent;
    readonly configuration: HappyAgentConfiguration;
    readonly http: AgentHttpServer;
    readonly socketPath: string;
    readonly tokenPath: string;
    close(ctx?: Context): Promise<void>;
}

/** Starts the complete local Happy agent and its private `/v0` Unix-socket API. */
export async function startHappyAgentDaemon(
    rootCtx: RootContext,
    options: StartHappyAgentDaemonOptions = {},
): Promise<HappyAgentDaemon> {
    // Resolve the layout before opening the socket, creating homes, or
    // constructing the Agent System. Runtime injections remain independent.
    const configModule = await ConfigModule.load(options.happyHome);
    const configuration = configModule.configuration;
    // Observation is started before anything it should be able to watch, and the root it installs
    // its logger and tracer on becomes the root every lifetime below is derived from. Contexts are
    // immutable, so a module that starts on the old root would log nowhere for ever.
    const observation = await ObservationModule.start({
        configuration,
        ...(options.version === undefined ? {} : { version: options.version }),
    });
    const ctx = observation.install(rootCtx);
    if (
        Object.keys(configuration.values.mcpServers).length > 0 &&
        options.integrations?.mcp === undefined
    ) {
        throw new Error(
            "MCP servers are configured, but this daemon has no capable MCP host integration.",
        );
    }
    const vanilla = createVanillaHappyAgentConfiguration(configuration, {
        filterModels: options.models === undefined,
    });
    const configuredProvider =
        configuration.values.providers[
            options.provider ?? configuration.values.defaults.providerId ?? vanilla.provider
        ];
    if (options.provider === undefined && configuredProvider?.enabled === false) {
        throw new Error(
            `Configured default provider "${configuration.values.defaults.providerId ?? vanilla.provider}" is disabled.`,
        );
    }
    const resolvedProvider =
        options.provider ?? configuration.values.defaults.providerId ?? vanilla.provider;
    const resolvedModels = options.models ?? vanilla.models;
    const resolvedProviders = options.providers ?? vanilla.providers;
    if (resolvedProviders.typeOf(resolvedProvider) === null) {
        throw new Error(`The default provider '${resolvedProvider}' is not registered.`);
    }
    const effectiveSelection = resolveEffectiveAgentSelection(
        configuration,
        resolvedModels,
        resolvedProvider,
        {
            ...(options.model === undefined ? {} : { model: options.model }),
            ...(options.effort === undefined ? {} : { effort: options.effort }),
            ...(options.serviceTier === undefined ? {} : { serviceTier: options.serviceTier }),
            fallbackToProviderRoute: options.models !== undefined || options.provider !== undefined,
        },
    );
    const effectiveModels = applyEffectiveAgentSelection(resolvedModels, effectiveSelection);
    const loadOptions: LoadHappyAgentOptions = {
        configuration,
        configModule,
        effectiveSelection,
        integrations: options.integrations ?? vanilla.integrations,
        models: effectiveModels,
        observation,
        provider: resolvedProvider,
        providers: resolvedProviders,
        ...(options.config === undefined ? {} : { config: options.config }),
        ...(options.events === undefined ? {} : { events: options.events }),
    };
    const httpConfiguration = {
        durableGlobalEventQueue: configuration.values.settings.durableGlobalEventQueue,
        inferenceMaxRetries: configuration.values.settings.inferenceMaxRetries,
        p2pName: configuration.values.p2p.name,
        ...(options.httpConfiguration ?? {}),
    };
    let closeDaemon: ((closeCtx?: Context) => Promise<void>) | undefined;
    const http = await startAgentHttpServer({
        agentConfiguration: configuration,
        ctx: ctx.named("happy-agent-http"),
        configuration: httpConfiguration,
        ...(options.routeGroups === undefined ? {} : { routeGroups: options.routeGroups }),
        ...(options.version === undefined ? {} : { version: options.version }),
        onShutdown: () => {
            void closeDaemon?.(ctx.named("happy-agent-http-shutdown")).catch(() => undefined);
        },
    });
    let agent: LoadedHappyAgent | undefined;
    try {
        agent = await loadHappyAgent(ctx.named("happy-agent"), loadOptions);
        await http.setAgent(agent);
    } catch (error) {
        await agent?.close(ctx.named("happy-agent-startup-cleanup")).catch(() => undefined);
        await http.close().catch(() => undefined);
        await observation.close(rootCtx).catch(() => undefined);
        throw error;
    }
    if (agent === undefined) throw new Error("The Happy agent did not finish loading.");

    let closing: Promise<void> | undefined;
    closeDaemon = (closeCtx = ctx.named("happy-agent-shutdown")) => {
        closing ??= closeHappyAgentDaemon(closeCtx, agent, http, observation);
        return closing;
    };
    return {
        agent,
        configuration,
        close: closeDaemon,
        http,
        socketPath: configuration.paths.socketPath,
        tokenPath: configuration.paths.tokenPath,
    };
}

async function closeHappyAgentDaemon(
    ctx: Context,
    agent: LoadedHappyAgent,
    http: AgentHttpServer,
    observation: ObservationModule,
): Promise<void> {
    const agentCtx = withAgentDatabase(ctx, agent.database);
    await agent.modules.events.record(agentCtx, {
        agentId: agent.agent.id,
        payload: {},
        type: "daemon.stopping",
    });
    const failures: unknown[] = [];
    await http.close().catch((error: unknown) => failures.push(error));
    await agent.close(agentCtx).catch((error: unknown) => failures.push(error));
    // Observation closes after everything it was watching, so the last thing the daemon did is
    // still in the file a person reads to find out why it stopped.
    await observation.close(ctx).catch((error: unknown) => failures.push(error));
    if (failures.length > 0) {
        throw new AggregateError(failures, "The Happy agent daemon did not close cleanly.");
    }
}
