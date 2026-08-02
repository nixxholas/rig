import { timingSafeEqual } from "node:crypto";
import { connect, createServer, type Socket } from "node:net";

import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import { armPluginDockerBridgeHandshakeTimeout } from "./armPluginDockerBridgeHandshakeTimeout.js";

const MAXIMUM_BRIDGE_CONNECTIONS = 64;

const tcpAddressSchema = Type.Object(
    {
        port: Type.Integer({ maximum: 65_535, minimum: 1 }),
    },
    { additionalProperties: true },
);

export interface PluginDockerSocketBridge {
    readonly port: number;
    close(): Promise<void>;
}

export async function startPluginDockerSocketBridge(
    socketPath: string,
    authenticationToken: string,
): Promise<PluginDockerSocketBridge> {
    const expectedToken = Buffer.from(authenticationToken);
    if (expectedToken.length === 0) {
        throw new Error("The Docker plugin socket bridge requires an authentication token.");
    }
    const sockets = new Set<Socket>();
    let activeConnections = 0;
    const server = createServer((client) => {
        if (activeConnections >= MAXIMUM_BRIDGE_CONNECTIONS) {
            client.destroy();
            return;
        }
        activeConnections += 1;
        trackSocket(client, sockets);
        const markClientEstablished = armPluginDockerBridgeHandshakeTimeout(client);
        client.once("close", () => {
            activeConnections -= 1;
        });
        let prefix = Buffer.alloc(0);
        const authenticate = (chunk: Buffer) => {
            const combined = Buffer.concat([prefix, chunk]);
            if (combined.length < expectedToken.length) {
                prefix = combined;
                return;
            }
            client.pause();
            client.off("data", authenticate);
            const remainder = readPluginDockerBridgeAuthentication(combined, authenticationToken);
            if (remainder === undefined) {
                client.destroy();
                return;
            }
            const upstream = connect(socketPath);
            trackSocket(upstream, sockets);
            const markUpstreamEstablished = armPluginDockerBridgeHandshakeTimeout(upstream);
            upstream.on("error", () => client.destroy());
            client.once("close", () => upstream.destroy());
            upstream.once("connect", () => {
                markClientEstablished();
                markUpstreamEstablished();
                if (remainder.length > 0) upstream.write(remainder);
                client.pipe(upstream);
                upstream.pipe(client);
                client.resume();
            });
        };
        client.on("data", authenticate);
    });
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
            server.off("error", reject);
            resolve();
        });
    });
    const address: unknown = server.address();
    if (!Value.Check(tcpAddressSchema, address)) {
        await closeServer(server);
        throw new Error("The Docker plugin socket bridge did not bind a TCP port.");
    }
    let closed = false;
    return {
        port: address.port,
        async close() {
            if (closed) return;
            closed = true;
            for (const socket of sockets) socket.destroy();
            sockets.clear();
            await closeServer(server);
        },
    };
}

export function readPluginDockerBridgeAuthentication(
    input: Buffer,
    authenticationToken: string,
): Buffer | undefined {
    const expectedToken = Buffer.from(authenticationToken);
    if (expectedToken.length === 0 || input.length < expectedToken.length) return undefined;
    const receivedToken = input.subarray(0, expectedToken.length);
    if (!timingSafeEqual(receivedToken, expectedToken)) return undefined;
    return input.subarray(expectedToken.length);
}

function trackSocket(socket: Socket, sockets: Set<Socket>): void {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => sockets.delete(socket));
}

function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
    if (!server.listening) return Promise.resolve();
    return new Promise<void>((resolve) => server.close(() => resolve()));
}
