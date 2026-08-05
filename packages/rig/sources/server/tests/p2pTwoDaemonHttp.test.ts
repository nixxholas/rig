import { request } from "node:http";
import type { IncomingHttpHeaders, Server } from "node:http";
import { rm } from "node:fs/promises";

import { Endpoint, RelayMode, SecretKey } from "@number0/iroh/index.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { IrohNetwork, P2pNetwork } from "../../p2p/index.js";
import { createP2pInstanceIdentity } from "../../p2p/P2pIdentity.js";
import { createTestSocketDirectory } from "../../testing/createTestSocketDirectory.js";
import { createProtocolHttpServer } from "../createProtocolHttpServer.js";
import { createServeP2pHttpRequest } from "../createServeP2pHttpRequest.js";

const ALPN = [...Buffer.from("rig/p2p/4", "utf8")];
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("P2P HTTP between two real daemon servers", () => {
    it("serves request/response and live events through the local peer prefix", async () => {
        const firstDaemon = await startDaemon("first-token");
        const secondDaemon = await startDaemon("second-token");
        const firstKey = SecretKey.generate();
        const secondKey = SecretKey.generate();
        const firstIdentity = createP2pInstanceIdentity();
        const secondIdentity = createP2pInstanceIdentity();
        const [firstEndpoint, secondEndpoint] = await Promise.all([
            Endpoint.bind({ alpns: [ALPN], secretKey: firstKey.toBytes() }, RelayMode.disabled()),
            Endpoint.bind({ alpns: [ALPN], secretKey: secondKey.toBytes() }, RelayMode.disabled()),
        ]);
        const firstId = firstEndpoint.id().toString();
        const secondId = secondEndpoint.id().toString();
        const firstNetwork = await P2pNetwork.create({
            config: {
                direct: {},
                enableDirect: false,
                enableIroh: true,
                enableSsh: false,
                exposeApi: false,
                iroh: {},
                peers: [
                    {
                        instanceId: secondIdentity.instanceId,
                        publicKey: secondIdentity.publicKey,
                        iroh: { endpointId: secondId },
                    },
                ],
            },
            createIrohTransport: (onStatusChange) =>
                IrohNetwork.create({
                    config: {},
                    endpointIds: [secondId],
                    endpoint: firstEndpoint,
                    identity: firstIdentity,
                    onStatusChange,
                    peerAddresses: new Map([[secondId, secondEndpoint.addr()]]),
                    relayMode: RelayMode.disabled(),
                    secretKey: firstKey,
                }),
            irohSecretKeyPath: "unused",
            identity: firstIdentity,
        });
        cleanups.push(() => firstNetwork.close());
        const secondNetwork = await P2pNetwork.create({
            config: {
                direct: {},
                enableDirect: false,
                enableIroh: true,
                enableSsh: false,
                exposeApi: true,
                iroh: {},
                peers: [
                    {
                        instanceId: firstIdentity.instanceId,
                        publicKey: firstIdentity.publicKey,
                        iroh: { endpointId: firstId },
                    },
                ],
            },
            createIrohTransport: (onStatusChange) =>
                IrohNetwork.create({
                    config: {},
                    endpointIds: [firstId],
                    endpoint: secondEndpoint,
                    identity: secondIdentity,
                    onStatusChange,
                    peerAddresses: new Map([[firstId, firstEndpoint.addr()]]),
                    relayMode: RelayMode.disabled(),
                    secretKey: secondKey,
                    serveRequest: createServeP2pHttpRequest({
                        socketPath: secondDaemon.socketPath,
                        token: "second-token",
                    }),
                }),
            irohSecretKeyPath: "unused",
            identity: secondIdentity,
        });
        cleanups.push(() => secondNetwork.close());
        await vi.waitFor(() => {
            expect(firstNetwork.status().transports[0]).toMatchObject({
                peers: [{ peerId: secondIdentity.instanceId, status: "connected" }],
            });
            expect(secondNetwork.status().transports[0]).toMatchObject({
                peers: [{ peerId: firstIdentity.instanceId, status: "connected" }],
            });
        });

        firstDaemon.server.closeAllConnections();
        await firstDaemon.close();
        const exposedFirst = await startDaemon("first-token", firstNetwork);
        const health = await get(
            exposedFirst.socketPath,
            `/p2p/peers/${secondIdentity.instanceId}/api/health`,
            "first-token",
        );
        expect(health.status).toBe(200);
        expect(JSON.parse(health.body)).toMatchObject({ status: "ready" });
        expect(health.headers["x-rig-p2p-peer"]).toBe(secondIdentity.instanceId);

        const hello = await readFirstSseFrame(
            exposedFirst.socketPath,
            `/p2p/peers/${secondIdentity.instanceId}/api/events/live`,
            "first-token",
        );
        expect(hello).toContain("event: hello");

        const exposedSecond = await startDaemon("second-token", secondNetwork);
        const refusal = await get(
            exposedSecond.socketPath,
            `/p2p/peers/${firstIdentity.instanceId}/api/health`,
            "second-token",
        );
        expect(refusal.status).toBe(502);
    });
});

async function startDaemon(
    token: string,
    p2pNetwork?: P2pNetwork,
): Promise<{ close: () => Promise<void>; server: Server; socketPath: string }> {
    const directory = await createTestSocketDirectory();
    const socketPath = `${directory}/server.sock`;
    const server = createProtocolHttpServer({
        ...(p2pNetwork === undefined ? {} : { p2pNetwork }),
        token,
    });
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, () => {
            server.off("error", reject);
            resolve();
        });
    });
    let closed = false;
    const close = async () => {
        if (closed) return;
        closed = true;
        await new Promise<void>((resolve, reject) => {
            server.close((error) => (error === undefined ? resolve() : reject(error)));
        });
        await rm(directory, { force: true, recursive: true });
    };
    cleanups.push(close);
    return { close, server, socketPath };
}

function get(
    socketPath: string,
    path: string,
    token: string,
): Promise<{
    body: string;
    headers: IncomingHttpHeaders;
    status: number;
}> {
    return new Promise((resolve, reject) => {
        const outgoing = request(
            { headers: { authorization: `Bearer ${token}` }, path, socketPath },
            (response) => {
                const chunks: Buffer[] = [];
                response.on("data", (chunk: Buffer) => chunks.push(chunk));
                response.once("end", () =>
                    resolve({
                        body: Buffer.concat(chunks).toString("utf8"),
                        headers: response.headers,
                        status: response.statusCode ?? 0,
                    }),
                );
            },
        );
        outgoing.once("error", reject);
        outgoing.end();
    });
}

function readFirstSseFrame(socketPath: string, path: string, token: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const outgoing = request(
            {
                headers: {
                    accept: "text/event-stream",
                    authorization: `Bearer ${token}`,
                },
                path,
                socketPath,
            },
            (response) => {
                let received = "";
                response.setEncoding("utf8");
                response.on("data", (chunk: string) => {
                    received += chunk;
                    if (!received.includes("event: hello")) return;
                    response.destroy();
                    outgoing.destroy();
                    resolve(received);
                });
            },
        );
        outgoing.once("error", (error) => {
            if (!outgoing.destroyed) reject(error);
        });
        outgoing.end();
    });
}
