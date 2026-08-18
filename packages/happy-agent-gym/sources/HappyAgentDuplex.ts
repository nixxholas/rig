import { request as httpRequest } from "node:http";
import type { Duplex } from "node:stream";

import type { HappyAgentClient } from "@slopus/happy-agent-client";
import { createNodeBinaryWebSocket, WebSocketDuplex } from "@slopus/happy-agent-modules/transport";
import WebSocket from "ws";

const MAX_TERMINAL_MESSAGE_BYTES = 4 * 1024 * 1024 + 20;

export interface HappyAgentSocketTransport {
    readonly socketPath: string;
    readonly token: string;
}

/**
 * Attach to a terminal using the URL produced by the public client.
 *
 * This adapter owns only Unix-socket WebSocket framing. Terminal wire messages
 * remain opaque bytes to the gym scenarios.
 */
export function connectTerminalWebSocket(
    client: HappyAgentClient,
    workspaceId: string,
    terminalId: string,
    transport: HappyAgentSocketTransport,
): Promise<Duplex> {
    const endpoint = new URL(client.terminalAttachUrl(workspaceId, terminalId));
    return new Promise<Duplex>((resolve, reject) => {
        const webSocket = new WebSocket(
            `ws+unix://${transport.socketPath}:${endpoint.pathname}${endpoint.search}`,
            {
                handshakeTimeout: 10_000,
                headers: { authorization: `Bearer ${transport.token}` },
                maxPayload: MAX_TERMINAL_MESSAGE_BYTES,
                perMessageDeflate: false,
            },
        );
        let settled = false;
        const fail = (error: Error): void => {
            if (settled) return;
            settled = true;
            webSocket.terminate();
            reject(error);
        };
        webSocket.once("error", fail);
        webSocket.once("unexpected-response", (_request, response) => {
            response.resume();
            fail(
                new Error(
                    `Terminal WebSocket failed with HTTP ${String(response.statusCode ?? 500)}.`,
                ),
            );
        });
        webSocket.once("open", () => {
            if (settled) return;
            settled = true;
            webSocket.off("error", fail);
            resolve(new WebSocketDuplex(createNodeBinaryWebSocket(webSocket)));
        });
    });
}

/**
 * Open the workspace's raw CONNECT tunnel using the public client's URL.
 *
 * The returned socket is the tunnel byte stream. Callers may speak HTTP or a
 * nested CONNECT protocol over it; this helper does not inspect either.
 */
export function connectWorkspaceProxy(
    client: HappyAgentClient,
    workspaceId: string,
    transport: HappyAgentSocketTransport,
): Promise<Duplex> {
    const endpoint = new URL(client.workspaceProxyUrl(workspaceId));
    return new Promise<Duplex>((resolve, reject) => {
        const request = httpRequest({
            headers: { authorization: `Bearer ${transport.token}` },
            method: "CONNECT",
            path: `${endpoint.pathname}${endpoint.search}`,
            socketPath: transport.socketPath,
        });
        let settled = false;
        const fail = (error: Error): void => {
            if (settled) return;
            settled = true;
            request.destroy();
            reject(error);
        };
        request.once("error", fail);
        request.once("response", (response) => {
            response.resume();
            fail(
                new Error(
                    `Workspace proxy failed with HTTP ${String(response.statusCode ?? 500)}.`,
                ),
            );
        });
        request.once("connect", (response, socket, head) => {
            if (settled) {
                socket.destroy();
                return;
            }
            if ((response.statusCode ?? 500) !== 200) {
                response.resume();
                fail(
                    new Error(
                        `Workspace proxy failed with HTTP ${String(response.statusCode ?? 500)}.`,
                    ),
                );
                socket.destroy();
                return;
            }
            settled = true;
            if (head.length > 0) socket.unshift(head);
            resolve(socket);
        });
        request.end();
    });
}
