import { mkdir } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { dirname } from "node:path";

import { span, type Context } from "@steve.kite/stdlib";

import type { LoadedHappyAgent } from "../agent/loadHappyAgent.js";
import { ProjectFilesModule } from "../files/ProjectFilesModule.js";
import { GitModule } from "../git/GitModule.js";
import { createLocalProjectWorkspaceHost } from "../projects/ProjectHost.js";
import { readOrCreateAgentToken, isAuthorizedAgentRequest } from "./auth.js";
import { AgentHttpError, sendError, sendJson } from "./errors.js";
import { createAgentRoutes } from "./agentRoutes.js";
import { createConfigRoutes } from "./configRoutes.js";
import { createCoreDaemonRoutes } from "./coreDaemonRoutes.js";
import { createEventRoutes } from "./eventRoutes.js";
import { createInspectorRoutes } from "./inspectorRoutes.js";
import { createFileRoutes } from "./fileRoutes.js";
import { createGitRoutes } from "./gitRoutes.js";
import { createProjectRoutes } from "./projectRoutes.js";
import { createSessionRoutes } from "./sessionRoutes.js";
import { createWorkspaceRoutes } from "./workspaceRoutes.js";
import {
    prepareAgentSocket,
    removeOwnedAgentSocket,
    resolveAgentDaemonPaths,
    secureAgentSocket,
} from "./paths.js";
import {
    dispatchAgentHttpRoute,
    routeContext,
    type AgentHttpConfiguration,
    type AgentHttpRouteGroup,
} from "./router.js";

export interface StartAgentHttpServerOptions {
    readonly agent?: LoadedHappyAgent;
    /** Required when the socket is opened before the Agent System finishes loading. */
    readonly agentHome?: string;
    readonly configuration?: AgentHttpConfiguration;
    readonly ctx: Context;
    readonly onShutdown?: () => void;
    readonly routeGroups?: readonly AgentHttpRouteGroup[];
    readonly socketPath?: string;
    readonly tokenPath?: string;
    readonly version?: string;
}

export interface AgentHttpServer {
    readonly socketPath: string;
    readonly tokenPath: string;
    setAgent(agent: LoadedHappyAgent): Promise<void>;
    close(): Promise<void>;
}

export async function startAgentHttpServer(
    options: StartAgentHttpServerOptions,
): Promise<AgentHttpServer> {
    const agentHome = options.agent?.agentHome ?? options.agentHome;
    if (agentHome === undefined) {
        throw new Error("The Happy agent home is required before opening its daemon socket.");
    }
    const paths = resolveAgentDaemonPaths(agentHome, options.socketPath, options.tokenPath);
    await mkdir(paths.agentHome, { mode: 0o700, recursive: true });
    await mkdir(dirname(paths.tokenPath), { mode: 0o700, recursive: true });
    const token = await readOrCreateAgentToken(paths.tokenPath);
    await prepareAgentSocket(paths);

    const connections = new Set<Socket>();
    const state: { agent?: LoadedHappyAgent; groups?: readonly AgentHttpRouteGroup[] } = {};
    const server = createServer((request, response) => {
        void span(options.ctx, "happy-agent-http-request", (requestCtx) =>
            handleRequest(requestCtx, request, response, options, token, state),
        ).catch((error: unknown) => {
            options.configuration?.onUnexpectedError?.(error);
            sendError(response, error);
        });
    });
    server.headersTimeout = 10_000;
    server.keepAliveTimeout = 5_000;
    server.requestTimeout = 30_000;
    server.on("connection", (socket) => {
        connections.add(socket);
        socket.once("close", () => connections.delete(socket));
    });

    let listening = false;
    const previousUmask = process.umask(0o077);
    try {
        await listen(server, paths.socketPath);
        listening = true;
        await secureAgentSocket(paths.socketPath);
    } catch (error) {
        if (listening) {
            await closeServer(server, connections, paths.socketPath).catch(() => undefined);
        }
        throw error;
    } finally {
        process.umask(previousUmask);
    }

    let closePromise: Promise<void> | undefined;
    const result: AgentHttpServer = {
        socketPath: paths.socketPath,
        tokenPath: paths.tokenPath,
        setAgent: async (agent) => {
            if (state.agent !== undefined && state.agent !== agent) {
                throw new Error("The Happy agent HTTP server is already ready.");
            }
            state.agent = agent;
            state.groups ??= routeGroups(options, agent);
        },
        close: () => {
            closePromise ??= closeServer(server, connections, paths.socketPath);
            return closePromise;
        },
    };
    if (options.agent !== undefined) await result.setAgent(options.agent);
    return result;
}

function routeGroups(
    options: StartAgentHttpServerOptions,
    agent: LoadedHappyAgent,
): readonly AgentHttpRouteGroup[] {
    const projectHost = options.configuration?.projectHost ?? createLocalProjectWorkspaceHost();
    const projectFiles =
        options.configuration?.projectFiles ??
        new ProjectFilesModule({
            git: projectHost.git,
            ...(projectHost.protectedPaths === undefined
                ? {}
                : { protectedPaths: projectHost.protectedPaths }),
            projects: agent.modules.projects,
            workspaces: agent.modules.workspaces,
        });
    const git =
        options.configuration?.git ??
        new GitModule({
            runner: projectHost.git,
        });
    return [
        ...(options.routeGroups ?? []),
        createCoreDaemonRoutes(),
        createConfigRoutes(),
        createEventRoutes(),
        createInspectorRoutes(),
        createAgentRoutes(),
        createSessionRoutes(),
        createProjectRoutes({
            agent,
            files: projectFiles,
            git,
            host: projectHost,
        }),
        createWorkspaceRoutes({
            agent,
            git,
            host: projectHost,
        }),
        createFileRoutes({
            agent,
            files: projectFiles,
        }),
        createGitRoutes({
            agent,
            files: projectFiles,
            git,
        }),
    ];
}

async function handleRequest(
    ctx: Context,
    request: IncomingMessage,
    response: ServerResponse,
    options: StartAgentHttpServerOptions,
    token: string,
    state: {
        readonly agent?: LoadedHappyAgent;
        readonly groups?: readonly AgentHttpRouteGroup[];
    },
): Promise<void> {
    if (!isAuthorizedAgentRequest(request.headers.authorization, token)) {
        sendJson(response, 401, { error: "Unauthorized" });
        return;
    }
    const url = new URL(request.url ?? "/", "http://happy-agent.local");
    if (state.agent === undefined || state.groups === undefined) {
        if (request.method === "GET" && url.pathname === "/v0/health") {
            sendJson(response, 200, {
                catalog: {
                    defaultModelId: "",
                    defaultProviderId: "",
                    models: [],
                    providers: [],
                },
                durableGlobalEventQueue: true,
                healthy: true,
                identity: { version: options.version ?? "0.0.0" },
                protocolVersion: 0,
                ready: false,
                status: "starting",
            });
            return;
        }
        sendJson(response, 503, { error: "The Happy agent is still starting." });
        return;
    }
    const context = routeContext(ctx, request, response, {
        agent: state.agent,
        ...(options.configuration === undefined ? {} : { configuration: options.configuration }),
        ...(options.onShutdown === undefined ? {} : { onShutdown: options.onShutdown }),
        ...(options.version === undefined ? {} : { version: options.version }),
    });
    try {
        await dispatchAgentHttpRoute(context, state.groups);
    } catch (error) {
        if (error instanceof AgentHttpError && Object.keys(error.headers).length > 0) {
            for (const [key, value] of Object.entries(error.headers)) {
                response.setHeader(key, value);
            }
        }
        throw error;
    }
}

async function listen(server: Server, socketPath: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        const onError = (error: Error): void => {
            server.off("listening", onListening);
            reject(error);
        };
        const onListening = (): void => {
            server.off("error", onError);
            resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(socketPath);
    });
}

async function closeServer(
    server: Server,
    connections: Set<Socket>,
    socketPath: string,
): Promise<void> {
    for (const connection of connections) connection.destroy();
    await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
    }).catch((error: unknown) => {
        if (!(error instanceof Error) || !/not running/i.test(error.message)) throw error;
    });
    await removeOwnedAgentSocket(socketPath);
}
