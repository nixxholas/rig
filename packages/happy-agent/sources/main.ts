import { withAgentDatabase } from "@slopus/happy-agent-base";
import type { HappyAgentConfiguration } from "@slopus/happy-agent-modules";

import {
    startHappyAgent,
    type StartedHappyAgent,
    type StartHappyAgentOptions,
} from "./start/startHappyAgent.js";
import {
    startAgentHttpServer,
    type AgentHttpConfiguration,
    type AgentHttpRouteGroup,
    type AgentHttpServer,
} from "./modules/http/index.js";

export interface StartHappyAgentDaemonOptions extends StartHappyAgentOptions {
    /** Optional host-backed daemon configuration and inspector capabilities. */
    readonly httpConfiguration?: AgentHttpConfiguration;
    /** Additional route families registered by the composition root. */
    readonly routeGroups?: readonly AgentHttpRouteGroup[];
}

export interface HappyAgentDaemon {
    readonly agent: StartedHappyAgent;
    readonly configuration: HappyAgentConfiguration;
    readonly http: AgentHttpServer;
    readonly socketPath: string;
    readonly tokenPath: string;
    close(): Promise<void>;
}

/**
 * Starts the complete local Happy agent and its private `/v0` Unix-socket API.
 *
 * The daemon is only the socket around the agent. The configuration decides everything the agent
 * itself is, so the caller says where the `.happy` folder is and nothing more.
 */
export async function startHappyAgentDaemon(
    options: StartHappyAgentDaemonOptions = {},
): Promise<HappyAgentDaemon> {
    const agent = await startHappyAgent(options);
    const configuration = agent.configuration;
    let closeDaemon: (() => Promise<void>) | undefined;
    let http: AgentHttpServer;
    try {
        http = await startAgentHttpServer({
            agent,
            agentConfiguration: configuration,
            ctx: agent.ctx.named("happy-agent-http"),
            configuration: {
                durableGlobalEventQueue: configuration.values.settings.durableGlobalEventQueue,
                inferenceMaxRetries: configuration.values.settings.inferenceMaxRetries,
                p2pName: configuration.values.p2p.name,
                ...(options.httpConfiguration ?? {}),
            },
            ...(options.routeGroups === undefined ? {} : { routeGroups: options.routeGroups }),
            ...(options.version === undefined ? {} : { version: options.version }),
            onShutdown: () => {
                void closeDaemon?.().catch(() => undefined);
            },
        });
    } catch (error) {
        await agent.close().catch(() => undefined);
        throw error;
    }

    let closing: Promise<void> | undefined;
    closeDaemon = () => {
        closing ??= closeHappyAgentDaemon(agent, http);
        return closing;
    };
    return {
        agent,
        close: closeDaemon,
        configuration,
        http,
        socketPath: configuration.paths.socketPath,
        tokenPath: configuration.paths.tokenPath,
    };
}

async function closeHappyAgentDaemon(
    agent: StartedHappyAgent,
    http: AgentHttpServer,
): Promise<void> {
    const ctx = agent.ctx.named("happy-agent-shutdown");
    await agent.modules.events
        .record(withAgentDatabase(ctx, agent.database), {
            payload: {},
            type: "daemon.stopping",
        })
        .catch(() => undefined);
    const failures: unknown[] = [];
    await http.close().catch((error: unknown) => failures.push(error));
    await agent.close().catch((error: unknown) => failures.push(error));
    if (failures.length > 0) {
        throw new AggregateError(failures, "The Happy agent daemon did not close cleanly.");
    }
}
