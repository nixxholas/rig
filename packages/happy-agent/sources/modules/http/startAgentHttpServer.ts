import { mkdir } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { dirname } from "node:path";

import { withAgentDatabase } from "@slopus/happy-agent-base";
import { span, type Context } from "@steve.kite/stdlib";

import type { StartedHappyAgent } from "../../start/startHappyAgent.js";
import type { HappyAgentConfiguration } from "@slopus/happy-agent-modules";
import { HAPPY_AGENT_RIG_PROTOCOL_VERSION } from "./rigProtocol.js";
import { ProjectFilesModule } from "../files/ProjectFilesModule.js";
import { GitModule } from "@slopus/happy-agent-modules";
import { readOrCreateAgentToken, isAuthorizedAgentRequest } from "./auth.js";
import { AgentHttpError, sendError, sendJson } from "./errors.js";
import { createAgentRoutes } from "./agentRoutes.js";
import { createCompatibilityRoutes } from "./compatibilityRoutes.js";
import { createConfigRoutes } from "./configRoutes.js";
import { createCoreDaemonRoutes } from "./coreDaemonRoutes.js";
import { createEventRoutes } from "./eventRoutes.js";
import { createInspectorRoutes } from "./inspectorRoutes.js";
import { createFileRoutes } from "./fileRoutes.js";
import { createGitRoutes } from "./gitRoutes.js";
import { createProjectRoutes } from "./projectRoutes.js";
import { createPresenceRoutes } from "./presenceRoutes.js";
import { createSecretRoutes } from "./secretRoutes.js";
import { createSessionRoutes } from "./sessionRoutes.js";
import { createSessionProcessRoutes } from "./sessionProcessRoutes.js";
import { createTerminalRoutes } from "./terminalRoutes.js";
import { attachTerminalWebSocketServer } from "./terminalAttach.js";
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
    readonly agent?: StartedHappyAgent;
    /** Required when the socket is opened before the Agent System finishes loading. */
    readonly agentConfiguration: HappyAgentConfiguration;
    readonly configuration?: AgentHttpConfiguration;
    readonly ctx: Context;
    readonly onShutdown?: () => void;
    readonly routeGroups?: readonly AgentHttpRouteGroup[];
    readonly version?: string;
}

export interface AgentHttpServer {
    readonly socketPath: string;
    readonly tokenPath: string;
    setAgent(agent: StartedHappyAgent): Promise<void>;
    close(): Promise<void>;
}

export async function startAgentHttpServer(
    options: StartAgentHttpServerOptions,
): Promise<AgentHttpServer> {
    const paths = resolveAgentDaemonPaths(options.agentConfiguration);
    await mkdir(paths.agentHome, { mode: 0o700, recursive: true });
    await mkdir(dirname(paths.tokenPath), { mode: 0o700, recursive: true });
    const token = await readOrCreateAgentToken(paths.tokenPath);
    await prepareAgentSocket(paths);

    const connections = new Set<Socket>();
    const state: { agent?: StartedHappyAgent; groups?: readonly AgentHttpRouteGroup[] } = {};
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
    // Attaching a terminal is an upgrade rather than a request: what it produces is a live screen,
    // which is a stream. It runs on the daemon's own lifetime because the attachment outlives the
    // upgrade, and it reads the same bearer token every other call on this socket does.
    const closeTerminalAttachments = attachTerminalWebSocketServer({
        agent: () => state.agent,
        ctx: options.ctx,
        server,
        token,
    });

    let listening = false;
    const previousUmask = process.umask(0o077);
    try {
        await listen(server, paths.socketPath);
        listening = true;
        await secureAgentSocket(paths.socketPath);
    } catch (error) {
        closeTerminalAttachments();
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
            closePromise ??= (async () => {
                closeTerminalAttachments();
                await closeServer(server, connections, paths.socketPath);
            })();
            return closePromise;
        },
    };
    if (options.agent !== undefined) await result.setAgent(options.agent);
    return result;
}

function routeGroups(
    options: StartAgentHttpServerOptions,
    agent: StartedHappyAgent,
): readonly AgentHttpRouteGroup[] {
    // The two catalogs the loader composed. Every route reads and writes through them, so a folder
    // a route reports and a folder the background work actually created are the same folder.
    const projects = agent.modules.projects;
    const protectedPaths = [
        ...new Set([
            ".git",
            "AGENTS.md",
            "AGENTS_SECURITY.md",
            ...agent.configuration.values.permissions.protectedPaths,
            ...agent.configuration.values.workspace.protectedSync,
        ]),
    ];
    const projectFiles =
        options.configuration?.projectFiles ??
        new ProjectFilesModule({
            git: projects.git,
            protectedPaths,
            projects,
            workspaces: agent.modules.workspaces,
        });
    const git = options.configuration?.git ?? new GitModule({ runner: projects.git });
    return [
        ...(options.routeGroups ?? []),
        createCoreDaemonRoutes(),
        createConfigRoutes(),
        createEventRoutes(),
        createCompatibilityRoutes(),
        createInspectorRoutes(),
        createAgentRoutes(),
        createPresenceRoutes(),
        createSecretRoutes(),
        createSessionRoutes(),
        createSessionProcessRoutes(),
        createProjectRoutes({
            agent,
            files: projectFiles,
            git,
        }),
        createTerminalRoutes({ agent }),
        createWorkspaceRoutes({
            agent,
            git,
        }),
        createFileRoutes({
            agent,
            files: projectFiles,
        }),
        createGitRoutes({
            agent,
            files: projectFiles,
            git,
            tracker: agent.gitTracker,
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
        readonly agent?: StartedHappyAgent;
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
                durableGlobalEventQueue: options.configuration?.durableGlobalEventQueue ?? false,
                healthy: true,
                identity: { version: options.version ?? "0.0.0" },
                protocolVersion: HAPPY_AGENT_RIG_PROTOCOL_VERSION,
                ready: false,
                status: "starting",
            });
            return;
        }
        sendJson(response, 503, { error: "The Happy agent is still starting." });
        return;
    }
    const context = routeContext(withAgentDatabase(ctx, state.agent.database), request, response, {
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
