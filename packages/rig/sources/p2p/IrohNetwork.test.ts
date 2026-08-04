import {
    Endpoint,
    RelayMode,
    SecretKey,
    type Connection,
    type EndpointAddr,
    type RecvStream,
    type SendStream,
} from "@number0/iroh/index.js";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createTestSocketDirectory } from "../testing/createTestSocketDirectory.js";
import { IrohNetwork } from "./IrohNetwork.js";
import { runIrohResponderHello } from "./IrohHelloProtocol.js";
import { createP2pInstanceIdentity } from "./P2pIdentity.js";
import { P2pPeerTrustStore } from "./P2pPeerTrustStore.js";

const ALPN = [...Buffer.from("rig/p2p/3", "utf8")];
const networks: IrohNetwork[] = [];
const directories: string[] = [];

afterEach(async () => {
    await Promise.all(networks.splice(0).map((network) => network.close()));
    await Promise.all(
        directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
    );
});

describe("IrohNetwork", () => {
    it("connects and keeps pinging when both endpoint identities are allowlisted", async () => {
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
        const firstStatusChanged = vi.fn();
        const first = await IrohNetwork.create({
            config: { trustedEndpointIds: [secondId] },
            endpoint: firstEndpoint,
            identity: firstIdentity,
            handshakeTimeoutMs: 100,
            idleTimeoutMs: 500,
            onStatusChange: firstStatusChanged,
            peerAddresses: new Map([[secondId, secondEndpoint.addr()]]),
            pingIntervalMs: 150,
            relayMode: RelayMode.disabled(),
            secretKey: firstKey,
        });
        networks.push(first);
        const second = await IrohNetwork.create({
            config: { trustedEndpointIds: [firstId] },
            endpoint: secondEndpoint,
            identity: secondIdentity,
            handshakeTimeoutMs: 100,
            idleTimeoutMs: 500,
            peerAddresses: new Map([[firstId, firstEndpoint.addr()]]),
            pingIntervalMs: 150,
            relayMode: RelayMode.disabled(),
            secretKey: secondKey,
        });
        networks.push(second);

        await vi.waitFor(() => {
            expect(first.status().peers[0]).toMatchObject({
                peerId: secondIdentity.instanceId,
                publicKey: secondIdentity.publicKey,
                status: "connected",
            });
            expect(second.status().peers[0]).toMatchObject({
                peerId: firstIdentity.instanceId,
                publicKey: firstIdentity.publicKey,
                status: "connected",
            });
        });
        const publishedAfterConnect = firstStatusChanged.mock.calls.length;
        const firstPingAt = first.status().peers[0]!.lastSeenAt!;
        await vi.waitFor(() =>
            expect(first.status().peers[0]!.lastSeenAt).toBeGreaterThan(firstPingAt),
        );
        expect(firstStatusChanged).toHaveBeenCalledTimes(publishedAfterConnect);
    });

    it("refuses a peer whose authenticated endpoint identity is not allowlisted", async () => {
        const allowedKey = SecretKey.generate();
        const refusedKey = SecretKey.generate();
        const allowedIdentity = createP2pInstanceIdentity();
        const refusedIdentity = createP2pInstanceIdentity();
        const [allowedEndpoint, refusedEndpoint] = await Promise.all([
            Endpoint.bind({ alpns: [ALPN], secretKey: allowedKey.toBytes() }, RelayMode.disabled()),
            Endpoint.bind({ alpns: [ALPN], secretKey: refusedKey.toBytes() }, RelayMode.disabled()),
        ]);
        const allowedId = allowedEndpoint.id().toString();
        const refusedId = refusedEndpoint.id().toString();
        const allowed = await IrohNetwork.create({
            config: { trustedEndpointIds: [] },
            endpoint: allowedEndpoint,
            identity: allowedIdentity,
            relayMode: RelayMode.disabled(),
            secretKey: allowedKey,
        });
        networks.push(allowed);
        const refused = await IrohNetwork.create({
            config: { trustedEndpointIds: [allowedId] },
            endpoint: refusedEndpoint,
            identity: refusedIdentity,
            peerAddresses: new Map([[allowedId, allowedEndpoint.addr()]]),
            pingIntervalMs: 10,
            relayMode: RelayMode.disabled(),
            secretKey: refusedKey,
        });
        networks.push(refused);

        await vi.waitFor(() => {
            expect(refused.status().peers[0]).toMatchObject({
                address: allowedId,
                status: "unreachable",
            });
        });
        expect(allowed.status()).toEqual({
            apiExposed: false,
            localAddress: allowedId,
            peers: [],
            state: "ready",
            transport: "iroh",
        });
        expect(refused.localAddress()).toBe(refusedId);
    });

    it("marks a connected peer unreachable when its ping stalls", async () => {
        const clientKey = SecretKey.generate();
        const serverKey = SecretKey.generate();
        const clientIdentity = createP2pInstanceIdentity();
        const [clientEndpoint, serverEndpoint] = await Promise.all([
            Endpoint.bind({ alpns: [ALPN], secretKey: clientKey.toBytes() }, RelayMode.disabled()),
            Endpoint.bind({ alpns: [ALPN], secretKey: serverKey.toBytes() }, RelayMode.disabled()),
        ]);
        const serverId = serverEndpoint.id().toString();
        const serverTask = (async () => {
            const incoming = await serverEndpoint.acceptNext();
            if (incoming === null) return;
            const connection = await (await incoming.accept()).connect();
            await connection.acceptBi();
            await connection.closed();
        })().catch(() => undefined);
        try {
            const client = await IrohNetwork.create({
                config: { trustedEndpointIds: [serverId] },
                endpoint: clientEndpoint,
                handshakeTimeoutMs: 25,
                identity: clientIdentity,
                peerAddresses: new Map([[serverId, serverEndpoint.addr()]]),
                pingIntervalMs: 10,
                pingTimeoutMs: 25,
                relayMode: RelayMode.disabled(),
                secretKey: clientKey,
            });
            networks.push(client);

            await vi.waitFor(() => {
                expect(client.status().peers[0]).toMatchObject({
                    address: serverId,
                    status: "unreachable",
                });
            });
        } finally {
            await serverEndpoint.close();
            await serverTask;
        }
    });

    it("rejects a transport-authenticated endpoint that presents the wrong stable key", async () => {
        const clientKey = SecretKey.generate();
        const serverKey = SecretKey.generate();
        const pinnedClientIdentity = createP2pInstanceIdentity();
        const impostorIdentity = createP2pInstanceIdentity(pinnedClientIdentity.instanceId);
        const serverIdentity = createP2pInstanceIdentity();
        const [clientEndpoint, serverEndpoint] = await Promise.all([
            Endpoint.bind({ alpns: [ALPN], secretKey: clientKey.toBytes() }, RelayMode.disabled()),
            Endpoint.bind({ alpns: [ALPN], secretKey: serverKey.toBytes() }, RelayMode.disabled()),
        ]);
        const clientId = clientEndpoint.id().toString();
        const serverId = serverEndpoint.id().toString();
        const directory = await createTestSocketDirectory();
        directories.push(directory);
        const trust = await P2pPeerTrustStore.open(join(directory, "peers.json"));
        await trust.verifyOrPin(pinnedClientIdentity, "iroh", clientId);

        const client = await IrohNetwork.create({
            config: { trustedEndpointIds: [serverId] },
            endpoint: clientEndpoint,
            identity: impostorIdentity,
            peerAddresses: new Map([[serverId, serverEndpoint.addr()]]),
            pingIntervalMs: 10,
            relayMode: RelayMode.disabled(),
            secretKey: clientKey,
        });
        networks.push(client);
        const server = await IrohNetwork.create({
            config: { trustedEndpointIds: [clientId] },
            endpoint: serverEndpoint,
            identity: serverIdentity,
            peerAddresses: new Map([[clientId, clientEndpoint.addr()]]),
            pingIntervalMs: 10,
            relayMode: RelayMode.disabled(),
            secretKey: serverKey,
            commitPeer: (identity, endpointId) => trust.verifyOrPin(identity, "iroh", endpointId),
            validatePeer: (identity, endpointId) => trust.validate(identity, "iroh", endpointId),
        });
        networks.push(server);

        await vi.waitFor(() =>
            expect(client.status().peers[0]).toMatchObject({
                address: serverId,
                status: "unreachable",
            }),
        );
        expect(server.status().peers[0]?.peerId).toBeUndefined();
    });

    it("does not pin an initiator peer before the responder confirms the handshake", async () => {
        const clientKey = SecretKey.generate();
        const serverKey = SecretKey.generate();
        const clientIdentity = createP2pInstanceIdentity();
        const serverIdentity = createP2pInstanceIdentity();
        const [clientEndpoint, serverEndpoint] = await Promise.all([
            Endpoint.bind({ alpns: [ALPN], secretKey: clientKey.toBytes() }, RelayMode.disabled()),
            Endpoint.bind({ alpns: [ALPN], secretKey: serverKey.toBytes() }, RelayMode.disabled()),
        ]);
        const clientId = clientEndpoint.id().toString();
        const serverId = serverEndpoint.id().toString();
        const directory = await createTestSocketDirectory();
        directories.push(directory);
        const clientTrust = await P2pPeerTrustStore.open(join(directory, "client-peers.json"));
        const serverTask = (async () => {
            const incoming = await serverEndpoint.acceptNext();
            if (incoming === null) return;
            const connection = await (await incoming.accept()).connect();
            const stream = await connection.acceptBi();
            await stream.recv.readExact(1);
            await runIrohResponderHello(stream.recv, stream.send, {
                commitPeer: async () => {
                    throw new Error("The responder refused to commit the peer.");
                },
                identity: serverIdentity,
                localEndpointId: serverId,
                remoteEndpointId: clientId,
            }).catch(() => undefined);
            connection.close(0n, []);
        })();
        const client = await IrohNetwork.create({
            commitPeer: (identity, endpointId) =>
                clientTrust.verifyOrPin(identity, "iroh", endpointId),
            config: { trustedEndpointIds: [serverId] },
            endpoint: clientEndpoint,
            identity: clientIdentity,
            peerAddresses: new Map([[serverId, serverEndpoint.addr()]]),
            pingIntervalMs: 10,
            relayMode: RelayMode.disabled(),
            secretKey: clientKey,
            validatePeer: (identity, endpointId) =>
                clientTrust.validate(identity, "iroh", endpointId),
        });
        networks.push(client);

        await vi.waitFor(() =>
            expect(client.status().peers[0]).toMatchObject({
                address: serverId,
                status: "unreachable",
            }),
        );
        expect(clientTrust.peerForBinding("iroh", serverId)).toBeUndefined();
        await serverTask;
        await serverEndpoint.close();
    });

    it("forwards an HTTP response stream without blocking peer pings", async () => {
        const clientKey = SecretKey.generate();
        const serverKey = SecretKey.generate();
        const clientIdentity = createP2pInstanceIdentity();
        const serverIdentity = createP2pInstanceIdentity();
        const [clientEndpoint, serverEndpoint] = await Promise.all([
            Endpoint.bind({ alpns: [ALPN], secretKey: clientKey.toBytes() }, RelayMode.disabled()),
            Endpoint.bind({ alpns: [ALPN], secretKey: serverKey.toBytes() }, RelayMode.disabled()),
        ]);
        const clientId = clientEndpoint.id().toString();
        const serverId = serverEndpoint.id().toString();
        let finishStream!: () => void;
        let cancellationObserved = false;
        let responseBodyStarted = false;
        let requestServed = false;
        const streamFinished = new Promise<void>((resolve) => {
            finishStream = resolve;
        });
        const client = await IrohNetwork.create({
            config: { trustedEndpointIds: [serverId] },
            endpoint: clientEndpoint,
            identity: clientIdentity,
            peerAddresses: new Map([[serverId, serverEndpoint.addr()]]),
            pingIntervalMs: 25,
            relayMode: RelayMode.disabled(),
            secretKey: clientKey,
        });
        networks.push(client);
        const server = await IrohNetwork.create({
            config: { trustedEndpointIds: [clientId] },
            endpoint: serverEndpoint,
            identity: serverIdentity,
            peerAddresses: new Map([[clientId, clientEndpoint.addr()]]),
            pingIntervalMs: 25,
            relayMode: RelayMode.disabled(),
            secretKey: serverKey,
            serveRequest: async (peerId, request, signal) => {
                requestServed = true;
                expect(peerId).toBe(clientIdentity.instanceId);
                if (request.path === "/cancel") {
                    return {
                        body: (async function* () {
                            yield Buffer.from("started");
                            await new Promise<void>((resolve) => {
                                if (signal.aborted) return resolve();
                                signal.addEventListener("abort", () => resolve(), { once: true });
                            });
                            cancellationObserved = true;
                        })(),
                        headers: { "content-type": "text/event-stream" },
                        status: 200,
                    };
                }
                expect(request).toMatchObject({
                    body: new Uint8Array(Buffer.from("hello")),
                    headers: { "content-type": "text/plain" },
                    method: "POST",
                    path: "/stream?room=one",
                });
                return {
                    body: (async function* () {
                        responseBodyStarted = true;
                        yield Buffer.from("first");
                        await streamFinished;
                        yield Buffer.from("second");
                    })(),
                    headers: { "content-type": "text/event-stream" },
                    status: 201,
                };
            },
        });
        networks.push(server);
        expect(server.status().apiExposed).toBe(true);
        await vi.waitFor(() =>
            expect(client.status().peers[0]).toMatchObject({ status: "connected" }),
        );
        const pingBeforeStream = client.status().peers[0]!.lastSeenAt!;
        const responsePromise = client.fetch(
            serverIdentity.instanceId,
            {
                body: Buffer.from("hello"),
                headers: { "content-type": "text/plain" },
                method: "POST",
                path: "/stream?room=one",
            },
            new AbortController().signal,
        );
        await vi.waitFor(() => expect(requestServed).toBe(true));
        await vi.waitFor(() => expect(responseBodyStarted).toBe(true));
        const response = await responsePromise;
        const chunks = response.body[Symbol.asyncIterator]();

        expect(response.status).toBe(201);
        await expect(chunks.next()).resolves.toMatchObject({
            done: false,
            value: new Uint8Array(Buffer.from("first")),
        });
        await vi.waitFor(() =>
            expect(client.status().peers[0]!.lastSeenAt).toBeGreaterThan(pingBeforeStream),
        );
        finishStream();
        await expect(chunks.next()).resolves.toMatchObject({
            done: false,
            value: new Uint8Array(Buffer.from("second")),
        });
        await expect(chunks.next()).resolves.toEqual({ done: true, value: undefined });

        const cancellation = new AbortController();
        const cancelledResponse = await client.fetch(
            serverIdentity.instanceId,
            { body: new Uint8Array(), headers: {}, method: "GET", path: "/cancel" },
            cancellation.signal,
        );
        const cancelledChunks = cancelledResponse.body[Symbol.asyncIterator]();
        await expect(cancelledChunks.next()).resolves.toMatchObject({
            done: false,
            value: new Uint8Array(Buffer.from("started")),
        });
        cancellation.abort();
        await vi.waitFor(() => expect(cancellationObserved).toBe(true));
    });

    it("retries a timed-out native connection without accumulating attempts", async () => {
        const ownId = "0".repeat(64);
        const peerId = "1".repeat(64);
        let finishAccept!: () => void;
        const accepted = new Promise<null>((resolve) => {
            finishAccept = () => resolve(null);
        });
        const connection = fakePingConnection(peerId, ownId, createP2pInstanceIdentity());
        let connectCount = 0;
        const endpoint = {
            acceptNext: () => accepted,
            close: async () => finishAccept(),
            connect: () => {
                connectCount += 1;
                return connectCount === 1
                    ? new Promise<Connection>(() => undefined)
                    : Promise.resolve(connection);
            },
            id: () => ({ toString: () => ownId }),
        } as unknown as Endpoint;
        const network = await IrohNetwork.create({
            bindings: {} as never,
            config: { trustedEndpointIds: [peerId] },
            connectTimeoutMs: 5,
            endpoint,
            peerAddresses: new Map([[peerId, {} as EndpointAddr]]),
            pingIntervalMs: 1_000,
            relayMode: RelayMode.disabled(),
            secretKey: null as never,
        });
        networks.push(network);

        await vi.waitFor(
            () => {
                expect(connectCount).toBe(2);
                expect(network.status().peers[0]).toMatchObject({ status: "connected" });
            },
            { timeout: 1_000 },
        );
    });

    it("bounds a stalled incoming authenticated handshake", async () => {
        const ownId = "0".repeat(64);
        let accepted = false;
        const endpoint = {
            acceptNext: async () => {
                if (accepted) return null;
                accepted = true;
                return {
                    accept: async () => ({
                        connect: () => new Promise<Connection>(() => undefined),
                    }),
                };
            },
            close: async () => undefined,
            id: () => ({ toString: () => ownId }),
        } as unknown as Endpoint;
        const network = await IrohNetwork.create({
            bindings: {} as never,
            config: { trustedEndpointIds: [] },
            endpoint,
            handshakeTimeoutMs: 5,
            relayMode: RelayMode.disabled(),
            secretKey: null as never,
        });

        await expect(network.close()).resolves.toBeUndefined();
    });

    it("bounds shutdown when the native endpoint does not close", async () => {
        const ownId = "0".repeat(64);
        const endpoint = {
            acceptNext: () => new Promise<null>(() => undefined),
            close: () => new Promise<void>(() => undefined),
            id: () => ({ toString: () => ownId }),
        } as unknown as Endpoint;
        const network = await IrohNetwork.create({
            bindings: {} as never,
            closeTimeoutMs: 5,
            config: { trustedEndpointIds: [] },
            endpoint,
            relayMode: RelayMode.disabled(),
            secretKey: null as never,
        });

        await expect(network.close()).resolves.toBeUndefined();
    });
});

function fakePingConnection(
    peerEndpointId: string,
    clientEndpointId: string,
    peerIdentity: ReturnType<typeof createP2pInstanceIdentity>,
): Connection {
    let streamCount = 0;
    return {
        close: () => undefined,
        openBi: async () => {
            streamCount += 1;
            if (streamCount === 1) {
                const pair = duplexPair();
                void (async () => {
                    await pair.right.recv.readExact(1);
                    await runIrohResponderHello(pair.right.recv, pair.right.send, {
                        identity: peerIdentity,
                        localEndpointId: peerEndpointId,
                        remoteEndpointId: clientEndpointId,
                    });
                })();
                return pair.left;
            }
            return {
                recv: {
                    readToEnd: async () => [1],
                },
                send: {
                    finish: async () => undefined,
                    writeAll: async () => undefined,
                },
            };
        },
        remoteId: () => ({ toString: () => peerEndpointId }),
    } as unknown as Connection;
}

function duplexPair(): {
    left: { recv: RecvStream; send: SendStream };
    right: { recv: RecvStream; send: SendStream };
} {
    const leftToRight = bytePipe();
    const rightToLeft = bytePipe();
    return {
        left: { recv: rightToLeft.recv, send: leftToRight.send },
        right: { recv: leftToRight.recv, send: rightToLeft.send },
    };
}

function bytePipe(): { recv: RecvStream; send: SendStream } {
    const bytes: number[] = [];
    const waiters: (() => void)[] = [];
    const wake = () => waiters.splice(0).forEach((waiter) => waiter());
    return {
        recv: {
            readExact: async (length: number) => {
                while (bytes.length < length) {
                    await new Promise<void>((resolve) => waiters.push(resolve));
                }
                return bytes.splice(0, length);
            },
        } as unknown as RecvStream,
        send: {
            finish: async () => undefined,
            writeAll: async (chunk: number[]) => {
                bytes.push(...chunk);
                wake();
            },
        } as unknown as SendStream,
    };
}
