import { withAgentDatabase } from "@slopus/happy-agent-base";
import type { Context, RootContext } from "@steve.kite/stdlib";

import {
    loadHappyAgent,
    type LoadedHappyAgent,
    type LoadHappyAgentOptions,
} from "./modules/agent/loadHappyAgent.js";
import {
    startAgentHttpServer,
    type AgentHttpConfiguration,
    type AgentHttpRouteGroup,
    type AgentHttpServer,
} from "./modules/http/index.js";

export interface StartHappyAgentDaemonOptions extends LoadHappyAgentOptions {
    /** Private Unix socket path. Defaults to `<agentHome>/server.sock`. */
    readonly socketPath?: string;
    /** Bearer token path. Defaults to `<agentHome>/token`. */
    readonly tokenPath?: string;
    /** Optional host-backed daemon configuration and inspector capabilities. */
    readonly httpConfiguration?: AgentHttpConfiguration;
    /** Additional route families registered by the composition root. */
    readonly routeGroups?: readonly AgentHttpRouteGroup[];
    /** Human-readable daemon version exposed by health/installation. */
    readonly version?: string;
}

export interface HappyAgentDaemon {
    readonly agent: LoadedHappyAgent;
    readonly http: AgentHttpServer;
    readonly socketPath: string;
    readonly tokenPath: string;
    close(ctx?: Context): Promise<void>;
}

/** Starts the complete local Happy agent and its private `/v0` Unix-socket API. */
export async function startHappyAgentDaemon(
    ctx: RootContext,
    options: StartHappyAgentDaemonOptions,
): Promise<HappyAgentDaemon> {
    let closeDaemon: ((closeCtx?: Context) => Promise<void>) | undefined;
    const http = await startAgentHttpServer({
        agentHome: options.agentHome,
        ctx: ctx.named("happy-agent-http"),
        ...(options.socketPath === undefined ? {} : { socketPath: options.socketPath }),
        ...(options.tokenPath === undefined ? {} : { tokenPath: options.tokenPath }),
        ...(options.httpConfiguration === undefined
            ? {}
            : { configuration: options.httpConfiguration }),
        ...(options.routeGroups === undefined ? {} : { routeGroups: options.routeGroups }),
        ...(options.version === undefined ? {} : { version: options.version }),
        onShutdown: () => {
            void closeDaemon?.(ctx.named("happy-agent-http-shutdown")).catch(() => undefined);
        },
    });
    let agent: LoadedHappyAgent | undefined;
    try {
        agent = await loadHappyAgent(ctx.named("happy-agent"), options);
        await http.setAgent(agent);
    } catch (error) {
        await agent?.close(ctx.named("happy-agent-startup-cleanup")).catch(() => undefined);
        await http.close().catch(() => undefined);
        throw error;
    }
    if (agent === undefined) throw new Error("The Happy agent did not finish loading.");

    let closing: Promise<void> | undefined;
    closeDaemon = (closeCtx = ctx.named("happy-agent-shutdown")) => {
        closing ??= closeHappyAgentDaemon(closeCtx, agent, http);
        return closing;
    };
    return {
        agent,
        close: closeDaemon,
        http,
        socketPath: http.socketPath,
        tokenPath: http.tokenPath,
    };
}

async function closeHappyAgentDaemon(
    ctx: Context,
    agent: LoadedHappyAgent,
    http: AgentHttpServer,
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
    if (failures.length > 0) {
        throw new AggregateError(failures, "The Happy agent daemon did not close cleanly.");
    }
}
