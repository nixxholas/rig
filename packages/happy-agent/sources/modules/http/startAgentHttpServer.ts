import { mkdir } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { dirname } from "node:path";

import { span, type Context } from "@steve.kite/stdlib";

import type { LoadedHappyAgent } from "../agent/loadHappyAgent.js";
import { readOrCreateAgentToken, isAuthorizedAgentRequest } from "./auth.js";
import { AgentHttpError, sendError, sendJson } from "./errors.js";
import { createAgentRoutes } from "./agentRoutes.js";
import { createConfigRoutes } from "./configRoutes.js";
import { createCoreDaemonRoutes } from "./coreDaemonRoutes.js";
import { createEventRoutes } from "./eventRoutes.js";
import { createInspectorRoutes } from "./inspectorRoutes.js";
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
    readonly agent: LoadedHappyAgent;
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
    close(): Promise<void>;
}

export async function startAgentHttpServer(
    options: StartAgentHttpServerOptions,
): Promise<AgentHttpServer> {
    const paths = resolveAgentDaemonPaths(
        options.agent.agentHome,
        options.socketPath,
        options.tokenPath,
    );
    await mkdir(paths.agentHome, { mode: 0o700, recursive: true });
    await mkdir(dirname(paths.tokenPath), { mode: 0o700, recursive: true });
    const token = await readOrCreateAgentToken(paths.tokenPath);
    await prepareAgentSocket(paths);

    const connections = new Set<Socket>();
    const server = createServer((request, response) => {
        void span(options.ctx, "happy-agent-http-request", (requestCtx) =>
            handleRequest(requestCtx, request, response, options, token, routeGroups(options)),
        ).catch((error: unknown) => {
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
        options.agent.modules.events.append({
            agentId: options.agent.agent.id,
            payload: { protocolVersion: 0 },
            type: "daemon.ready",
        });
    } catch (error) {
        if (listening) {
            await closeServer(server, connections, paths.socketPath).catch(() => undefined);
        } else {
            await removeOwnedAgentSocket(paths.socketPath).catch(() => undefined);
        }
        throw error;
    } finally {
        process.umask(previousUmask);
    }

    let closePromise: Promise<void> | undefined;
    return {
        socketPath: paths.socketPath,
        tokenPath: paths.tokenPath,
        close: () => {
            closePromise ??= closeServer(server, connections, paths.socketPath);
            return closePromise;
        },
    };
}

function routeGroups(options: StartAgentHttpServerOptions): readonly AgentHttpRouteGroup[] {
    return [
        ...(options.routeGroups ?? []),
        createCoreDaemonRoutes(),
        createConfigRoutes(),
        createEventRoutes(),
        createInspectorRoutes(),
        createAgentRoutes(),
    ];
}

async function handleRequest(
    ctx: Context,
    request: IncomingMessage,
    response: ServerResponse,
    options: StartAgentHttpServerOptions,
    token: string,
    groups: readonly AgentHttpRouteGroup[],
): Promise<void> {
    if (!isAuthorizedAgentRequest(request.headers.authorization, token)) {
        sendJson(response, 401, { error: "Unauthorized" });
        return;
    }
    const context = routeContext(ctx, request, response, {
        agent: options.agent,
        ...(options.configuration === undefined ? {} : { configuration: options.configuration }),
        ...(options.onShutdown === undefined ? {} : { onShutdown: options.onShutdown }),
        ...(options.version === undefined ? {} : { version: options.version }),
    });
    try {
        await dispatchAgentHttpRoute(context, groups);
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
