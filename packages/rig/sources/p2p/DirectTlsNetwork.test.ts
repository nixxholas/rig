import { connect, createServer } from "node:net";
import { once } from "node:events";
import { Transform } from "node:stream";

import type { Context } from "@steve.kite/stdlib";
import { describe, expect, it, vi } from "vitest";

import { createTestRootContext } from "../testing/createTestRootContext.js";

import { createP2pInstanceIdentity } from "./P2pIdentity.js";
import { DirectTlsNetwork } from "./DirectTlsNetwork.js";

const ctx = createTestRootContext();

describe("direct TLS P2P transport", () => {
    it("uses one finite operation context for validation and commit on every repeated authentication", async () => {
        const [clientPort, serverPort] = await Promise.all([reservePort(), reservePort()]);
        const clientIdentity = createP2pInstanceIdentity();
        const serverIdentity = createP2pInstanceIdentity();
        const clientAddress = `127.0.0.1:${String(clientPort)}`;
        const serverAddress = `127.0.0.1:${String(serverPort)}`;
        const operations: Context[] = [];
        const validated: Context[] = [];
        const committed: Context[] = [];
        const server = await DirectTlsNetwork.create({
            config: { listen: serverAddress },
            identity: serverIdentity,
            peers: [
                {
                    bindings: [],
                    connections: { direct: { address: clientAddress } },
                    instanceId: clientIdentity.instanceId,
                    name: "Client",
                    publicKey: clientIdentity.publicKey,
                },
            ],
            serveRequest: async () => response("ok"),
            startPings: false,
        });
        const client = await DirectTlsNetwork.create({
            commitPeer: async (ctx) => {
                committed.push(ctx);
            },
            config: { listen: clientAddress },
            identity: clientIdentity,
            peers: [
                {
                    bindings: [],
                    connections: { direct: { address: serverAddress } },
                    instanceId: serverIdentity.instanceId,
                    name: "Server",
                    publicKey: serverIdentity.publicKey,
                },
            ],
            runPeerOperation: async <Result>(
                _operation: "handshake",
                work: (ctx: Context) => Result | PromiseLike<Result>,
            ): Promise<Awaited<Result>> => {
                const operationCtx = ctx.named(`direct-handshake-${String(operations.length)}`);
                operations.push(operationCtx);
                return await work(operationCtx);
            },
            startPings: false,
            validatePeer: async (ctx) => {
                validated.push(ctx);
            },
        });
        try {
            for (let index = 0; index < 2; index += 1) {
                const result = await client.fetch(
                    ctx,
                    serverIdentity.instanceId,
                    { body: new Uint8Array(), headers: {}, method: "GET", path: "/health" },
                    new AbortController().signal,
                );
                await collect(result.body);
            }

            expect(operations).toHaveLength(2);
            expect(validated).toEqual(operations);
            expect(committed).toEqual(operations);
        } finally {
            await Promise.all([client.close(), server.close()]);
        }
    });

    it("authenticates both stable identities and forwards streaming HTTP in either direction", async () => {
        const [firstPort, secondPort] = await Promise.all([reservePort(), reservePort()]);
        const firstIdentity = createP2pInstanceIdentity(
            "ck1234567890abcdefghijkl",
            Uint8Array.from({ length: 32 }, (_, index) => index + 1),
        );
        const secondIdentity = createP2pInstanceIdentity(
            "dk1234567890abcdefghijkl",
            Uint8Array.from({ length: 32 }, (_, index) => index + 33),
        );
        const firstAddress = `127.0.0.1:${String(firstPort)}`;
        const secondAddress = `127.0.0.1:${String(secondPort)}`;
        const first = await DirectTlsNetwork.create({
            config: { listen: firstAddress },
            identity: firstIdentity,
            peers: [
                {
                    bindings: [],
                    connections: { direct: { address: secondAddress } },
                    name: "Peer",
                    instanceId: secondIdentity.instanceId,
                    publicKey: secondIdentity.publicKey,
                },
            ],
            serveRequest: async (peerId) => response(peerId),
        });
        const second = await DirectTlsNetwork.create({
            config: { listen: secondAddress },
            identity: secondIdentity,
            peers: [
                {
                    bindings: [],
                    connections: { direct: { address: firstAddress } },
                    name: "Peer",
                    instanceId: firstIdentity.instanceId,
                    publicKey: firstIdentity.publicKey,
                },
            ],
            serveRequest: async (peerId) => response(peerId),
        });
        try {
            await vi.waitFor(
                () => {
                    expect(first.peerApiAvailable(secondIdentity.instanceId)).toBe(true);
                    expect(second.peerApiAvailable(firstIdentity.instanceId)).toBe(true);
                },
                { timeout: 3_000 },
            );
            const firstResponse = await first.fetch(
                ctx,
                secondIdentity.instanceId,
                { body: new Uint8Array(), headers: {}, method: "GET", path: "/health" },
                new AbortController().signal,
            );
            expect(firstResponse.status).toBe(200);
            expect(await collect(firstResponse.body)).toBe(firstIdentity.instanceId);

            const secondResponse = await second.fetch(
                ctx,
                firstIdentity.instanceId,
                { body: new Uint8Array(), headers: {}, method: "GET", path: "/health" },
                new AbortController().signal,
            );
            expect(await collect(secondResponse.body)).toBe(secondIdentity.instanceId);
        } finally {
            await Promise.all([first.close(), second.close()]);
        }
    });

    it("opens a bidirectional tunnel and holds capacity until cancellation", async () => {
        const [clientPort, serverPort] = await Promise.all([reservePort(), reservePort()]);
        const clientIdentity = createP2pInstanceIdentity();
        const serverIdentity = createP2pInstanceIdentity();
        const clientAddress = `127.0.0.1:${String(clientPort)}`;
        const serverAddress = `127.0.0.1:${String(serverPort)}`;
        let servedPeerId: string | undefined;
        let servedPath: string | undefined;
        let servingAborted: Promise<void> | undefined;
        const client = await DirectTlsNetwork.create({
            config: { listen: clientAddress },
            identity: clientIdentity,
            maximumConnections: 1,
            peers: [
                {
                    bindings: [],
                    connections: { direct: { address: serverAddress } },
                    name: "Peer",
                    instanceId: serverIdentity.instanceId,
                    publicKey: serverIdentity.publicKey,
                },
            ],
            startPings: false,
        });
        const server = await DirectTlsNetwork.create({
            config: { listen: serverAddress },
            identity: serverIdentity,
            peers: [
                {
                    bindings: [],
                    connections: { direct: { address: clientAddress } },
                    name: "Peer",
                    instanceId: clientIdentity.instanceId,
                    publicKey: clientIdentity.publicKey,
                },
            ],
            serveTunnel: async (peerId, request, signal) => {
                servedPeerId = peerId;
                servedPath = request.path;
                servingAborted = waitForAbort(signal);
                return {
                    response: { headers: { upgrade: "websocket" }, status: 101 },
                    stream: new Transform({
                        transform(chunk: Buffer, _encoding, callback) {
                            callback(null, Buffer.from(chunk.toString("utf8").toUpperCase()));
                        },
                    }),
                };
            },
            startPings: false,
        });
        const controller = new AbortController();
        try {
            const tunnel = await client.openTunnel(
                ctx,
                serverIdentity.instanceId,
                {
                    headers: {
                        connection: "Upgrade",
                        "sec-websocket-key": "test-key",
                        "sec-websocket-version": "13",
                        upgrade: "websocket",
                    },
                    method: "GET",
                    path: "/projects/project/terminals/terminal/attach",
                },
                controller.signal,
            );
            tunnel.stream.on("error", () => undefined);
            expect(tunnel.response).toEqual({
                headers: { upgrade: "websocket" },
                status: 101,
            });
            expect(servedPeerId).toBe(clientIdentity.instanceId);
            expect(servedPath).toBe("/projects/project/terminals/terminal/attach");

            const received = once(tunnel.stream, "data");
            tunnel.stream.write(Buffer.from("hello"));
            expect(Buffer.from((await received)[0] as Buffer).toString("utf8")).toBe("HELLO");

            await expect(
                client.openTunnel(
                    ctx,
                    serverIdentity.instanceId,
                    {
                        headers: {},
                        method: "GET",
                        path: "/projects/project/terminals/other/attach",
                    },
                    new AbortController().signal,
                ),
            ).rejects.toThrow("Too many outbound direct P2P connections");

            controller.abort();
            await deadline(servingAborted!, "The served direct tunnel was not cancelled.");
        } finally {
            controller.abort();
            await Promise.all([client.close(), server.close()]);
        }
    });

    it("refuses a TLS identity key that is not on the configured peer allowlist", async () => {
        const [firstPort, secondPort] = await Promise.all([reservePort(), reservePort()]);
        const firstIdentity = createP2pInstanceIdentity();
        const secondIdentity = createP2pInstanceIdentity();
        const impostorIdentity = createP2pInstanceIdentity();
        const first = await DirectTlsNetwork.create({
            config: { listen: `127.0.0.1:${String(firstPort)}` },
            identity: firstIdentity,
            peers: [
                {
                    bindings: [],
                    connections: { direct: { address: `127.0.0.1:${String(secondPort)}` } },
                    name: "Peer",
                    instanceId: secondIdentity.instanceId,
                    publicKey: secondIdentity.publicKey,
                },
            ],
        });
        const impostor = await DirectTlsNetwork.create({
            config: { listen: `127.0.0.1:${String(secondPort)}` },
            identity: impostorIdentity,
            peers: [
                {
                    bindings: [],
                    connections: { direct: { address: `127.0.0.1:${String(firstPort)}` } },
                    name: "Peer",
                    instanceId: firstIdentity.instanceId,
                    publicKey: firstIdentity.publicKey,
                },
            ],
        });
        try {
            await expect(
                first.fetch(
                    ctx,
                    secondIdentity.instanceId,
                    { body: new Uint8Array(), headers: {}, method: "GET", path: "/health" },
                    new AbortController().signal,
                ),
            ).rejects.toThrow("certificate key does not match");
        } finally {
            await Promise.all([first.close(), impostor.close()]);
        }
    });

    it("keeps inbound capacity reserved while a TLS client stalls before hello", async () => {
        const port = await reservePort();
        const network = await DirectTlsNetwork.create({
            config: { listen: `127.0.0.1:${String(port)}` },
            identity: createP2pInstanceIdentity(),
            maximumConnections: 2,
            peers: [],
        });
        const first = connect(port, "127.0.0.1");
        const second = connect(port, "127.0.0.1");
        const third = connect(port, "127.0.0.1");
        const thirdClosed = new Promise<void>((resolve) => third.once("close", () => resolve()));
        try {
            await Promise.all([connected(first), connected(second)]);
            await thirdClosed;
            expect(first.destroyed).toBe(false);
            expect(second.destroyed).toBe(false);
        } finally {
            first.destroy();
            second.destroy();
            third.destroy();
            await network.close();
        }
    });

    it("reserves outbound capacity for the full streaming response lifetime", async () => {
        const [clientPort, serverPort] = await Promise.all([reservePort(), reservePort()]);
        const clientIdentity = createP2pInstanceIdentity();
        const serverIdentity = createP2pInstanceIdentity();
        const clientAddress = `127.0.0.1:${String(clientPort)}`;
        const serverAddress = `127.0.0.1:${String(serverPort)}`;
        const client = await DirectTlsNetwork.create({
            config: { listen: clientAddress },
            identity: clientIdentity,
            maximumConnections: 2,
            peers: [
                {
                    bindings: [],
                    connections: { direct: { address: serverAddress } },
                    name: "Peer",
                    instanceId: serverIdentity.instanceId,
                    publicKey: serverIdentity.publicKey,
                },
            ],
            startPings: false,
        });
        const server = await DirectTlsNetwork.create({
            closeTimeoutMs: 100,
            config: { listen: serverAddress },
            identity: serverIdentity,
            peers: [
                {
                    bindings: [],
                    connections: { direct: { address: clientAddress } },
                    name: "Peer",
                    instanceId: clientIdentity.instanceId,
                    publicKey: clientIdentity.publicKey,
                },
            ],
            serveRequest: async (_peerId, _request, signal) => ({
                body: (async function* () {
                    await waitForAbort(signal);
                    yield Buffer.alloc(0);
                })(),
                headers: {},
                status: 200,
            }),
            startPings: false,
        });
        const controllers = [new AbortController(), new AbortController()];
        try {
            await deadline(
                Promise.all(
                    controllers.map((controller) =>
                        client.fetch(
                            ctx,
                            serverIdentity.instanceId,
                            {
                                body: Buffer.alloc(0),
                                headers: {},
                                method: "GET",
                                path: "/events/live",
                            },
                            controller.signal,
                        ),
                    ),
                ),
                "The two streaming direct requests did not open.",
            );

            await expect(
                client.fetch(
                    ctx,
                    serverIdentity.instanceId,
                    { body: Buffer.alloc(0), headers: {}, method: "GET", path: "/health" },
                    new AbortController().signal,
                ),
            ).rejects.toThrow("Too many outbound direct P2P connections");
        } finally {
            for (const controller of controllers) controller.abort();
            await deadline(client.close(), "The direct client did not close.");
            await deadline(server.close(), "The direct server did not close.");
        }
    });
});

function response(peerId: string) {
    return {
        body: (async function* () {
            yield Buffer.from(peerId);
        })(),
        headers: { "content-type": "text/plain" },
        status: 200,
    };
}

async function collect(body: AsyncIterable<Uint8Array>): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of body) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString("utf8");
}

async function reservePort(): Promise<number> {
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Expected a TCP port.");
    await new Promise<void>((resolve) => server.close(() => resolve()));
    return address.port;
}

function connected(socket: ReturnType<typeof connect>): Promise<void> {
    return new Promise((resolve, reject) => {
        socket.once("connect", resolve);
        socket.once("error", reject);
    });
}

function waitForAbort(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.resolve();
    return new Promise((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
    );
}

function deadline<T>(operation: Promise<T>, message: string): Promise<T> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(message)), 1_000);
        void operation.then(
            (value) => {
                clearTimeout(timer);
                resolve(value);
            },
            (error: unknown) => {
                clearTimeout(timer);
                reject(error);
            },
        );
    });
}
