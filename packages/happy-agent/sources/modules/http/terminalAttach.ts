import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";

import { withAgentDatabase } from "@slopus/happy-agent-base";
import type { TerminalScope } from "@slopus/happy-agent-modules";
import { span, type Context } from "@steve.kite/stdlib";
import { WebSocketServer } from "ws";

import type { StartedHappyAgent } from "../../start/startHappyAgent.js";
import { createNodeBinaryWebSocket } from "../terminal/createNodeBinaryWebSocket.js";
import { WebSocketDuplex } from "../terminal/WebSocketDuplex.js";
import { isAuthorizedAgentRequest } from "./auth.js";

/**
 * The largest single wire packet, plus the framing the protocol puts around it. A message past
 * this is not a slow client but a broken one, and the connection is dropped rather than buffered.
 */
const MAX_WIRE_MESSAGE_BYTES = 4 * 1024 * 1024 + 20;

export interface TerminalAttachOptions {
    /** The daemon's own lifetime. An attachment outlives the upgrade that opened it. */
    readonly ctx: Context;
    /** The started agent, or nothing while the daemon is still coming up. */
    readonly agent: () => StartedHappyAgent | undefined;
    readonly server: Server;
    readonly token: string;
}

/**
 * Serves terminal attachments over an HTTP upgrade on the daemon's own socket.
 *
 * Upgrading keeps attachments on the routing and bearer-token rails everything else already uses,
 * and WebSocket supplies the binary framing and full-duplex input the protocol needs. Every binary
 * message is exactly one complete wire packet; a text message is a client that does not speak this
 * protocol, so the protocol layer refuses it rather than guessing.
 */
export function attachTerminalWebSocketServer(options: TerminalAttachOptions): () => void {
    const webSocketServer = new WebSocketServer({
        maxPayload: MAX_WIRE_MESSAGE_BYTES,
        noServer: true,
        // The wire protocol compresses what is worth compressing and bounds what it produces.
        // A second, unbounded compressor over the top of it would only cost memory.
        perMessageDeflate: false,
    });

    const onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
        const route = matchTerminalAttachRoute(request.url);
        if (route === undefined) {
            refuse(socket, 404, "Not Found");
            return;
        }
        if (!isAuthorizedAgentRequest(request.headers.authorization, options.token)) {
            refuse(socket, 401, "Unauthorized");
            return;
        }
        const agent = options.agent();
        if (agent === undefined) {
            refuse(socket, 503, "Service Unavailable");
            return;
        }
        void span(options.ctx, "happy-agent-terminal-attach", async (attachCtx) => {
            const ctx = withAgentDatabase(attachCtx, agent.database);
            const session = await agent.modules.terminals.session(
                ctx,
                route.scope,
                route.terminalId,
            );
            webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
                const stream = new WebSocketDuplex(createNodeBinaryWebSocket(webSocket));
                const detach = session.attach(stream);
                stream.once("close", detach);
            });
        }).catch((error: unknown) => {
            options.ctx.log.debug("A terminal attachment was refused.", {}, error);
            refuse(socket, 404, "Not Found");
        });
    };

    options.server.on("upgrade", onUpgrade);

    // Closing the HTTP server drops its own connections; an upgraded socket is no longer one of
    // them, so the attachments are ended here or the process would not exit.
    const closeAllConnections = options.server.closeAllConnections.bind(options.server);
    options.server.closeAllConnections = () => {
        for (const client of webSocketServer.clients) client.terminate();
        closeAllConnections();
    };

    return () => {
        options.server.off("upgrade", onUpgrade);
        for (const client of webSocketServer.clients) client.terminate();
        webSocketServer.close();
    };
}

export interface TerminalAttachRoute {
    readonly scope: TerminalScope;
    readonly terminalId: string;
}

/** The two attach paths, project-scoped and workspace-scoped, and nothing else. */
export function matchTerminalAttachRoute(
    requestUrl: string | undefined,
): TerminalAttachRoute | undefined {
    let parts: string[];
    try {
        parts = new URL(requestUrl ?? "/", "http://happy-agent.local").pathname
            .split("/")
            .filter(Boolean)
            .map((part) => decodeURIComponent(part));
    } catch {
        return undefined;
    }
    if (parts[0] !== "v0" || parts[1] !== "projects") return undefined;
    const projectId = parts[2];
    if (projectId === undefined || projectId.length === 0) return undefined;
    if (parts.length === 6 && parts[3] === "terminals" && parts[5] === "attach") {
        const terminalId = parts[4];
        if (terminalId === undefined || terminalId.length === 0) return undefined;
        return { scope: { projectId }, terminalId };
    }
    if (
        parts.length === 8 &&
        parts[3] === "workspaces" &&
        parts[5] === "terminals" &&
        parts[7] === "attach"
    ) {
        const workspaceId = parts[4];
        const terminalId = parts[6];
        if (workspaceId === undefined || workspaceId.length === 0) return undefined;
        if (terminalId === undefined || terminalId.length === 0) return undefined;
        return { scope: { projectId, workspaceId }, terminalId };
    }
    return undefined;
}

function refuse(socket: Duplex, status: number, statusText: string): void {
    if (socket.destroyed) return;
    socket.end(`HTTP/1.1 ${status} ${statusText}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`, () =>
        socket.destroy(),
    );
}
