import type {
    Connection,
    Endpoint,
    EndpointAddr,
    RelayMode,
    SecretKey,
} from "@number0/iroh/index.js";
import { finished } from "node:stream/promises";

import type { Context } from "@steve.kite/stdlib";

import type { ConfigIrohTransport } from "../config/types.js";
import { errorToMessage } from "../errorToMessage.js";
import type { P2pPeerStatus, P2pTransportStatus } from "../protocol/P2pProtocol.js";
import {
    createIrohFrameDuplex,
    finishWrites,
    P2pFrameWriteTimeoutError,
    withFrameProgressDeadline,
} from "./P2pFrameDuplex.js";
import {
    readP2pHttpRequest,
    readP2pHttpResponse,
    writeP2pHttpFailure,
    writeP2pHttpRequest,
    writeP2pHttpResponse,
} from "./P2pFrameProtocol.js";
import { runP2pInitiatorHello, runP2pResponderHello } from "./P2pHelloProtocol.js";
import { loadIrohBindings } from "./loadIrohBindings.js";
import {
    createP2pInstanceIdentity,
    type P2pInstanceIdentity,
    type P2pPeerIdentity,
} from "./P2pIdentity.js";
import type { P2pHttpRequest, P2pHttpResponse, ServeP2pHttpRequest } from "./P2pHttp.js";
import type { P2pTransport } from "./P2pTransport.js";
import {
    readP2pTunnelRequest,
    readP2pTunnelResponse,
    writeP2pTunnelFailure,
    writeP2pTunnelRequest,
    writeP2pTunnelResponse,
} from "./P2pTunnelProtocol.js";
import { createP2pTunnelStream } from "./P2pTunnelStream.js";
import {
    createClosedP2pTunnelStream,
    type P2pTunnelConnection,
    type P2pTunnelRequestHead,
    type ServeP2pTunnel,
} from "./P2pTunnel.js";
import { waitForAbortOrTimeout } from "./waitForAbortOrTimeout.js";

const IROH_ALPN = [...Buffer.from("rig/p2p/5", "utf8")];
const STREAM_KIND_PING = 1;
const STREAM_KIND_HTTP = 2;
const STREAM_KIND_HELLO = 3;
const STREAM_KIND_TUNNEL = 4;
const PING_CAPABILITIES_VERSION = 1;
const CLOSE_CANCELLED = 499n;
const CLOSE_UNAUTHORIZED = 403n;
const CLOSE_SHUTDOWN = 0n;
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 5_000;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 5_000;
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
const DEFAULT_PING_INTERVAL_MS = 10_000;
const DEFAULT_PING_TIMEOUT_MS = 5_000;
const DEFAULT_ADDRESS_READY_TIMEOUT_MS = 30_000;
const DEFAULT_ADDRESS_SUPERVISION_INTERVAL_MS = 5_000;
const DEFAULT_RESTART_COOLDOWN_MS = 30_000;
const INITIAL_RETRY_MS = 250;
const MAXIMUM_STANDARD_CONNECTS_PER_PEER = 2;
const MAXIMUM_HTTP_REQUESTS = 32;
const MAXIMUM_CONNECTION_STREAMS = MAXIMUM_HTTP_REQUESTS + 1;
const MAXIMUM_RETRY_MS = 10_000;
const REQUEST_BODY_TIMEOUT_MS = 120_000;
const RESPONSE_HEAD_TIMEOUT_MS = 30_000;
const RESPONSE_WRITE_PROGRESS_TIMEOUT_MS = 30_000;

export interface CreateIrohNetworkOptions {
    apiExposed?: boolean;
    /** Test seam. Production dynamically loads the platform's native Iroh binding. */
    bindings?: IrohBindings;
    closeTimeoutMs?: number;
    commitPeer?: (ctx: Context, identity: P2pPeerIdentity, endpointId: string) => Promise<void>;
    config: ConfigIrohTransport;
    connectTimeoutMs?: number;
    endpointIds: readonly string[];
    handshakeTimeoutMs?: number;
    idleTimeoutMs?: number;
    identity?: P2pInstanceIdentity;
    secretKey: SecretKey;
    /** Test seam for a pre-bound relay-free endpoint. */
    endpoint?: Endpoint;
    /** Test seam for rebuilding a wedged endpoint with the same identity. */
    endpointFactory?: () => Promise<Endpoint>;
    /** Test seam for direct, relay-free endpoint addresses. */
    peerAddresses?: ReadonlyMap<string, EndpointAddr>;
    /** Durable endpoint tickets learned during pairing or a prior connection. */
    peerTickets?: ReadonlyMap<string, string>;
    /** Test seam. Production uses Iroh's n0 relay and discovery preset. */
    relayMode?: RelayMode;
    /** Creates one finite trace context for a peer authentication operation. */
    runPeerOperation?: <Result>(
        operation: "address-refresh" | "handshake",
        work: (ctx: Context) => Result | PromiseLike<Result>,
    ) => Promise<Awaited<Result>>;
    pingIntervalMs?: number;
    pingTimeoutMs?: number;
    responseWriteProgressTimeoutMs?: number;
    addressReadyTimeoutMs?: number;
    addressSupervisionIntervalMs?: number;
    restartCooldownMs?: number;
    knownPeer?: (endpointId: string) => (P2pPeerIdentity & { name: string }) | undefined;
    serveRequest?: ServeP2pHttpRequest;
    serveTunnel?: ServeP2pTunnel;
    validatePeer?: (ctx: Context, identity: P2pPeerIdentity, endpointId: string) => Promise<void>;
    updatePeerAddress?: (
        ctx: Context,
        identity: P2pPeerIdentity,
        endpointId: string,
        ticket: string,
    ) => Promise<void>;
    onStatusChange?: (status: P2pTransportStatus) => void;
}

interface IrohOutgoingConnectionEntry {
    activeApplicationStreams: number;
    closeWhenIdle?: boolean;
    connection?: Connection;
    promise?: Promise<IrohSharedConnection>;
}

interface IrohSharedConnection {
    connection: Connection;
    entry: IrohOutgoingConnectionEntry;
    identity: P2pPeerIdentity;
}

interface IrohConnectedEndpoint {
    connection: Connection;
    endpoint: Endpoint;
}

interface IrohPeerStream {
    entry: IrohOutgoingConnectionEntry;
    stream: Awaited<ReturnType<Connection["openBi"]>>;
}

export class IrohNetwork implements P2pTransport {
    readonly kind = "iroh";
    readonly #apiExposed: boolean;
    readonly #abort = new AbortController();
    readonly #allowedPeers: Set<string>;
    readonly #bindings: IrohBindings;
    readonly #closeTimeoutMs: number;
    readonly #commitPeer:
        | ((ctx: Context, identity: P2pPeerIdentity, endpointId: string) => Promise<void>)
        | undefined;
    readonly #config: ConfigIrohTransport;
    readonly #connectTimeoutMs: number;
    #endpoint: Endpoint;
    readonly #endpointFactory: (() => Promise<Endpoint>) | undefined;
    readonly #endpointIds: string[];
    readonly #handshakeTimeoutMs: number;
    readonly #idleTimeoutMs: number;
    readonly #identity: P2pInstanceIdentity;
    readonly #knownPeer:
        | ((endpointId: string) => (P2pPeerIdentity & { name: string }) | undefined)
        | undefined;
    readonly #onStatusChange: ((status: P2pTransportStatus) => void) | undefined;
    readonly #pendingConnectChanges = new Map<string, AbortController>();
    readonly #pendingConnects = new Map<string, Set<Promise<Connection>>>();
    readonly #outgoingConnections = new Map<string, IrohOutgoingConnectionEntry>();
    readonly #peerAddresses: Map<string, EndpointAddr>;
    readonly #peerDiscoveryProbes = new Set<string>();
    readonly #peerNeedsDiscovery = new Set<string>();
    readonly #peerTickets = new Map<string, string>();
    readonly #peerActivityRevisions = new Map<string, number>();
    readonly #peerLastActivityAt = new Map<string, number>();
    readonly #peerLastActivityPublishedAt = new Map<string, number>();
    readonly #peerApiAvailable = new Map<string, boolean>();
    readonly #peerStatuses = new Map<string, P2pPeerStatus>();
    readonly #peerIdentities = new Map<string, P2pPeerIdentity>();
    readonly #peerNames = new Map<string, string>();
    readonly #pingIntervalMs: number;
    readonly #pingTimeoutMs: number;
    readonly #responseWriteProgressTimeoutMs: number;
    readonly #runPeerOperation: CreateIrohNetworkOptions["runPeerOperation"];
    readonly #addressReadyTimeoutMs: number;
    readonly #addressSupervisionIntervalMs: number;
    readonly #restartCooldownMs: number;
    readonly #serveRequest: ServeP2pHttpRequest | undefined;
    readonly #serveTunnel: ServeP2pTunnel | undefined;
    readonly #tasks = new Set<Promise<void>>();
    readonly #validatePeer:
        | ((ctx: Context, identity: P2pPeerIdentity, endpointId: string) => Promise<void>)
        | undefined;
    readonly #updatePeerAddress:
        | ((
              ctx: Context,
              identity: P2pPeerIdentity,
              endpointId: string,
              ticket: string,
          ) => Promise<void>)
        | undefined;
    readonly #authenticatedConnections = new Set<Connection>();
    #endpointClosePending: Promise<void> | undefined;
    #endpointRestart: Promise<void> | undefined;
    #lastEndpointRestartAt = 0;
    #retryWake = new AbortController();
    #httpRequestCount = 0;
    #incomingHttpRequestCount = 0;
    #closed = false;

    private constructor(
        endpoint: Endpoint,
        bindings: IrohBindings,
        options: CreateIrohNetworkOptions,
        endpointFactory?: () => Promise<Endpoint>,
    ) {
        this.#apiExposed = options.apiExposed ?? options.serveRequest !== undefined;
        this.#bindings = bindings;
        this.#endpoint = endpoint;
        this.#endpointFactory = endpointFactory;
        this.#config = options.config;
        this.#closeTimeoutMs = options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS;
        this.#commitPeer = options.commitPeer;
        this.#connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
        this.#handshakeTimeoutMs = options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
        this.#identity = options.identity ?? createP2pInstanceIdentity();
        this.#endpointIds = [...options.endpointIds];
        this.#allowedPeers = new Set(options.endpointIds);
        this.#knownPeer = options.knownPeer;
        this.#peerAddresses = new Map(options.peerAddresses);
        for (const [endpointId, ticket] of options.peerTickets ?? []) {
            this.#setPeerTicket(endpointId, ticket);
        }
        this.#pingIntervalMs = options.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS;
        this.#idleTimeoutMs = Math.max(
            options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
            this.#pingIntervalMs * 3,
        );
        this.#pingTimeoutMs = options.pingTimeoutMs ?? DEFAULT_PING_TIMEOUT_MS;
        this.#responseWriteProgressTimeoutMs =
            options.responseWriteProgressTimeoutMs ?? RESPONSE_WRITE_PROGRESS_TIMEOUT_MS;
        this.#runPeerOperation = options.runPeerOperation;
        this.#addressReadyTimeoutMs =
            options.addressReadyTimeoutMs ?? DEFAULT_ADDRESS_READY_TIMEOUT_MS;
        this.#addressSupervisionIntervalMs =
            options.addressSupervisionIntervalMs ?? DEFAULT_ADDRESS_SUPERVISION_INTERVAL_MS;
        this.#restartCooldownMs = options.restartCooldownMs ?? DEFAULT_RESTART_COOLDOWN_MS;
        this.#serveRequest = options.serveRequest;
        this.#serveTunnel = options.serveTunnel;
        this.#onStatusChange = options.onStatusChange;
        this.#validatePeer = options.validatePeer;
        this.#updatePeerAddress = options.updatePeerAddress;
        for (const endpointId of options.endpointIds) {
            const known = this.#knownPeer?.(endpointId);
            if (known === undefined) {
                throw new Error(
                    "Every configured Iroh peer must have a trusted identity and name.",
                );
            }
            this.#peerIdentities.set(endpointId, known);
            this.#peerNames.set(endpointId, known.name);
            this.#peerStatuses.set(endpointId, {
                address: endpointId,
                name: known.name,
                peerId: known.instanceId,
                publicKey: known.publicKey,
                status: "connecting",
            });
        }
    }

    static async create(options: CreateIrohNetworkOptions): Promise<IrohNetwork> {
        const bindings = options.bindings ?? (await loadIrohBindings());
        const relayMode =
            options.relayMode ??
            (options.config.relayUrl === undefined
                ? bindings.RelayMode.defaultMode()
                : bindings.RelayMode.customFromUrls([options.config.relayUrl]));
        const createEndpoint =
            options.endpointFactory ??
            (() =>
                bindings.Endpoint.bind(
                    { alpns: [IROH_ALPN], secretKey: options.secretKey.toBytes() },
                    relayMode,
                ));
        const endpoint = options.endpoint ?? (await createEndpoint());
        if (options.endpointIds.includes(endpoint.id().toString())) {
            await endpoint.close();
            throw new Error(
                "A configured P2P peer must not use this daemon's own Iroh endpoint ID.",
            );
        }
        const network = new IrohNetwork(
            endpoint,
            bindings,
            options,
            options.endpointFactory ??
                (options.endpoint === undefined ? createEndpoint : undefined),
        );
        network.#start();
        return network;
    }

    localAddress(): string {
        return this.#endpoint.id().toString();
    }

    addPeer(endpointId: string, identity: P2pPeerIdentity, name: string, ticket?: string): void {
        if (endpointId === this.localAddress()) {
            throw new Error("A P2P peer must not use this daemon's own Iroh endpoint ID.");
        }
        const previousIdentity = this.#peerIdentities.get(endpointId);
        if (
            previousIdentity !== undefined &&
            (previousIdentity.instanceId !== identity.instanceId ||
                previousIdentity.publicKey !== identity.publicKey)
        ) {
            const connection = this.#outgoingConnections.get(endpointId);
            if (connection !== undefined) {
                this.#retireOutgoingConnection(endpointId, connection, "close");
            }
        }
        this.#peerIdentities.set(endpointId, identity);
        if (ticket !== undefined) this.#setPeerTicket(endpointId, ticket);
        this.#peerNames.set(endpointId, name);
        if (this.#allowedPeers.has(endpointId)) {
            this.#setPeerStatus(endpointId, this.#statusFor(endpointId, "connecting"));
            return;
        }
        this.#allowedPeers.add(endpointId);
        this.#endpointIds.push(endpointId);
        this.#peerStatuses.set(endpointId, {
            address: endpointId,
            name,
            peerId: identity.instanceId,
            publicKey: identity.publicKey,
            status: "connecting",
        });
        this.#track(this.#pingPeer(endpointId));
        this.#publishStatus();
    }

    async endpointTicket(): Promise<string> {
        const endpoint = this.#endpoint;
        const deadline = Date.now() + this.#addressReadyTimeoutMs;
        while (!this.#abort.signal.aborted && endpoint === this.#endpoint) {
            const address = endpoint.addr();
            if (address.relayUrl() !== null) {
                return this.#bindings.EndpointTicket.fromAddr(address).toString();
            }
            if (Date.now() >= deadline) {
                throw new Error("The stable Iroh endpoint could not select a relay address.");
            }
            await this.#wait(Math.min(250, deadline - Date.now()));
        }
        if (endpoint !== this.#endpoint) return this.endpointTicket();
        throw new Error("Iroh networking stopped before its endpoint address was ready.");
    }

    status(): Extract<P2pTransportStatus, { state: "ready"; transport: "iroh" }> {
        return {
            apiExposed: this.#apiExposed,
            localAddress: this.localAddress(),
            peers: this.#endpointIds.map((endpointId) => ({
                ...this.#peerStatuses.get(endpointId)!,
            })),
            ...(this.#config.relayUrl === undefined ? {} : { relayUrl: this.#config.relayUrl }),
            state: "ready",
            transport: "iroh",
        };
    }

    peerApiAvailable(peerId: string): boolean {
        for (const [endpointId, identity] of this.#peerIdentities) {
            if (identity.instanceId === peerId)
                return this.#peerApiAvailable.get(endpointId) === true;
        }
        return false;
    }

    async fetch(
        ctx: Context,
        peerId: string,
        request: P2pHttpRequest,
        signal: AbortSignal,
    ): Promise<P2pHttpResponse> {
        return await ctx.span("rig.p2p.iroh.fetch", async () => {
            const endpointId = this.#endpointForPeer(peerId);
            if (this.#httpRequestCount >= MAXIMUM_HTTP_REQUESTS) {
                throw new Error("Too many P2P HTTP requests are already active.");
            }
            this.#httpRequestCount += 1;
            let peerStream: IrohPeerStream | undefined;
            let released = false;
            const release = (completed = false): void => {
                if (released) return;
                released = true;
                signal.removeEventListener("abort", abort);
                if (peerStream !== undefined) {
                    if (completed) {
                        this.#track(
                            finishIrohHttpStream(
                                peerStream.stream,
                                this.#responseWriteProgressTimeoutMs,
                            ),
                        );
                    } else cancelIrohStream(peerStream.stream);
                    this.#releaseOutgoingApplicationStream(peerStream.entry);
                }
                this.#httpRequestCount -= 1;
            };
            const abort = (): void => release(false);
            try {
                signal.throwIfAborted();
                peerStream = await this.#openPeerStream(
                    endpointId,
                    peerId,
                    signal,
                    "The peer did not open an HTTP stream in time.",
                );
                signal.addEventListener("abort", abort, { once: true });
                await withAbort(peerStream.stream.send.writeAll([STREAM_KIND_HTTP]), signal);
                const duplex = createIrohFrameDuplex(
                    peerStream.stream.recv,
                    peerStream.stream.send,
                    () => this.#recordPeerActivity(endpointId),
                );
                await withAbort(
                    withDeadline(
                        writeP2pHttpRequest(duplex.send, request, { finish: false }),
                        REQUEST_BODY_TIMEOUT_MS,
                        "The P2P HTTP request took too long to send.",
                    ),
                    signal,
                );
                return await withAbort(
                    withDeadline(
                        readP2pHttpResponse(duplex.recv, release),
                        RESPONSE_HEAD_TIMEOUT_MS,
                        "The peer did not return HTTP response headers in time.",
                    ),
                    signal,
                );
            } catch (error) {
                release(false);
                throw error;
            }
        });
    }

    async openTunnel(
        ctx: Context,
        peerId: string,
        request: P2pTunnelRequestHead,
        signal: AbortSignal,
    ): Promise<P2pTunnelConnection> {
        return await ctx.span("rig.p2p.iroh.openTunnel", async () => {
            const endpointId = this.#endpointForPeer(peerId);
            if (this.#httpRequestCount >= MAXIMUM_HTTP_REQUESTS) {
                throw new Error("Too many P2P tunnels are already active.");
            }
            this.#httpRequestCount += 1;
            let peerStream: IrohPeerStream | undefined;
            let released = false;
            const release = (): void => {
                if (released) return;
                released = true;
                signal.removeEventListener("abort", abort);
                if (peerStream !== undefined) {
                    cancelIrohStream(peerStream.stream);
                    this.#releaseOutgoingApplicationStream(peerStream.entry);
                }
                this.#httpRequestCount -= 1;
            };
            const abort = (): void => release();
            try {
                signal.throwIfAborted();
                peerStream = await this.#openPeerStream(
                    endpointId,
                    peerId,
                    signal,
                    "The peer did not open a tunnel stream in time.",
                );
                signal.addEventListener("abort", abort, { once: true });
                await withAbort(peerStream.stream.send.writeAll([STREAM_KIND_TUNNEL]), signal);
                const duplex = createIrohFrameDuplex(
                    peerStream.stream.recv,
                    peerStream.stream.send,
                    () => this.#recordPeerActivity(endpointId),
                );
                await withAbort(writeP2pTunnelRequest(duplex.send, request), signal);
                const response = await withAbort(
                    withDeadline(
                        readP2pTunnelResponse(duplex.recv),
                        RESPONSE_HEAD_TIMEOUT_MS,
                        "The peer did not return tunnel response headers in time.",
                    ),
                    signal,
                );
                if (response.status !== (request.method === "GET" ? 101 : 200)) {
                    release();
                    return { response, stream: createClosedP2pTunnelStream() };
                }
                return {
                    response,
                    stream: createP2pTunnelStream(duplex, { close: release, signal }),
                };
            } catch (error) {
                release();
                throw error;
            }
        });
    }

    async close(): Promise<void> {
        if (this.#closed) return;
        this.#closed = true;
        this.#abort.abort();
        this.#retryWake.abort();
        for (const controller of this.#pendingConnectChanges.values()) controller.abort();
        this.#pendingConnectChanges.clear();
        for (const [endpointId, entry] of this.#outgoingConnections) {
            this.#retireOutgoingConnection(endpointId, entry, "close");
        }
        this.#outgoingConnections.clear();
        for (const connection of this.#authenticatedConnections) {
            connection.close(CLOSE_SHUTDOWN, []);
        }
        const endpointClose = this.#endpointClosePending ?? this.#endpoint.close();
        await Promise.allSettled([
            withDeadline(
                endpointClose,
                this.#closeTimeoutMs,
                "The Iroh endpoint did not close in time.",
            ),
            withDeadline(
                Promise.allSettled(this.#tasks),
                this.#closeTimeoutMs,
                "Iroh networking tasks did not stop in time.",
            ),
        ]);
    }

    #start(): void {
        this.#startEndpoint(this.#endpoint);
        for (const endpointId of this.#endpointIds) {
            this.#track(this.#pingPeer(endpointId));
        }
        this.#publishStatus();
    }

    #startEndpoint(endpoint: Endpoint): void {
        this.#track(this.#acceptConnections(endpoint));
        if (typeof endpoint.addr === "function") {
            // Polling is intentional: iroh-js 1.1 watcher callbacks can panic outside its
            // Tokio reactor. Endpoint polling and the ping loop use the same path on macOS,
            // Linux, and Linux containers, including Docker Desktop's hidden VM boundary.
            this.#track(this.#superviseEndpoint(endpoint));
        }
    }

    async #acceptConnections(endpoint: Endpoint): Promise<void> {
        let retryMs = INITIAL_RETRY_MS;
        while (!this.#abort.signal.aborted && this.#endpoint === endpoint) {
            try {
                const incoming = await endpoint.acceptNext();
                if (incoming === null) return;
                retryMs = INITIAL_RETRY_MS;
                this.#track(this.#acceptConnection(incoming));
            } catch {
                if (!this.#abort.signal.aborted && this.#endpoint === endpoint) {
                    await this.#wait(retryMs);
                }
                retryMs = Math.min(MAXIMUM_RETRY_MS, retryMs * 2);
            }
        }
    }

    async #acceptConnection(
        incoming: NonNullable<Awaited<ReturnType<Endpoint["acceptNext"]>>>,
    ): Promise<void> {
        let connection: Connection | undefined;
        let tracked = false;
        try {
            const accepting = await withDeadline(
                incoming.accept(),
                this.#handshakeTimeoutMs,
                "The incoming Iroh handshake did not start in time.",
            );
            const connectionAttempt = accepting.connect();
            try {
                connection = await withDeadline(
                    connectionAttempt,
                    this.#handshakeTimeoutMs,
                    "The incoming Iroh handshake did not finish in time.",
                );
            } catch (error) {
                void connectionAttempt.then(
                    (lateConnection) => lateConnection.close(CLOSE_SHUTDOWN, []),
                    () => undefined,
                );
                throw error;
            }
            const remoteId = connection.remoteId().toString();
            if (!this.#allowedPeers.has(remoteId)) {
                connection.close(CLOSE_UNAUTHORIZED, [...Buffer.from("endpoint not allowed")]);
                return;
            }
            connection.setMaxConcurrentBiStreams(BigInt(MAXIMUM_CONNECTION_STREAMS));
            const stream = await withDeadline(
                connection.acceptBi(),
                this.#handshakeTimeoutMs,
                "The peer did not open its signed identity hello in time.",
            );
            const kind = (
                await withDeadline(
                    stream.recv.readExact(1),
                    this.#handshakeTimeoutMs,
                    "The peer did not identify its signed identity hello in time.",
                )
            )[0];
            if (kind !== STREAM_KIND_HELLO) {
                connection.close(CLOSE_UNAUTHORIZED, [
                    ...Buffer.from("signed identity hello required"),
                ]);
                return;
            }
            const authenticated = await this.#withPeerOperation("handshake", async (ctx) => {
                const peer = await runP2pResponderHello(
                    withFrameProgressDeadline(
                        createIrohFrameDuplex(stream.recv, stream.send),
                        this.#handshakeTimeoutMs,
                        () =>
                            new IrohOperationTimeoutError(
                                "The peer did not finish its signed identity hello in time.",
                            ),
                    ),
                    {
                        commitPeer: (identity, endpointId) =>
                            this.#commitAuthenticatedPeer(ctx, identity, endpointId),
                        identity: this.#identity,
                        localChannelBinding: this.localAddress(),
                        remoteChannelBinding: remoteId,
                        transport: "iroh",
                        validatePeer: (identity, endpointId) =>
                            this.#validateAuthenticatedPeer(ctx, identity, endpointId),
                    },
                );
                await withDeadline(
                    stream.recv.readToEnd(0),
                    this.#handshakeTimeoutMs,
                    "The peer did not finish its signed identity hello stream in time.",
                );
                return peer;
            });
            this.#rememberPeer(remoteId, authenticated);
            this.#recordPeerActivity(remoteId);
            this.#authenticatedConnections.add(connection);
            tracked = true;
            await this.#serveConnection(connection, authenticated.instanceId, remoteId);
        } catch {
            connection?.close(CLOSE_SHUTDOWN, []);
        } finally {
            if (tracked && connection !== undefined) {
                this.#authenticatedConnections.delete(connection);
            }
        }
    }

    async #serveConnection(
        connection: Connection,
        peerId: string,
        endpointId: string,
    ): Promise<void> {
        const streams = new Set<Promise<void>>();
        const controller = new AbortController();
        let accepting: ReturnType<Connection["acceptBi"]> | undefined;
        if (typeof connection.closed === "function") {
            void connection.closed().then(
                (reason) => controller.abort(new Error(reason)),
                (error: unknown) => controller.abort(error),
            );
        }
        try {
            while (!this.#abort.signal.aborted) {
                if (streams.size >= MAXIMUM_CONNECTION_STREAMS) {
                    await Promise.race(streams);
                    continue;
                }
                accepting ??= connection.acceptBi();
                const stream =
                    streams.size === 0
                        ? await withDeadline(
                              accepting,
                              this.#idleTimeoutMs,
                              "The peer did not open a P2P stream in time.",
                          )
                        : await Promise.race([
                              accepting,
                              Promise.race(streams).then(() => undefined),
                          ]);
                if (stream === undefined) continue;
                accepting = undefined;
                const serving = this.#serveStream(
                    peerId,
                    endpointId,
                    stream,
                    controller.signal,
                ).catch(() => undefined);
                streams.add(serving);
                void serving.then(
                    () => streams.delete(serving),
                    () => streams.delete(serving),
                );
            }
        } finally {
            connection.close(CLOSE_SHUTDOWN, []);
            controller.abort(new Error("The Iroh connection stopped."));
            await withDeadline(
                Promise.allSettled(streams),
                this.#closeTimeoutMs,
                "The Iroh connection's active streams did not stop in time.",
            ).catch(() => undefined);
        }
    }

    async #serveStream(
        peerId: string,
        endpointId: string,
        stream: Awaited<ReturnType<Connection["acceptBi"]>>,
        connectionSignal: AbortSignal,
    ): Promise<void> {
        let kind: number | undefined;
        try {
            kind = (
                await withDeadline(
                    stream.recv.readExact(1),
                    this.#pingTimeoutMs,
                    "The peer did not identify its P2P request in time.",
                )
            )[0];
            this.#recordPeerActivity(endpointId);
        } catch (error) {
            cancelIrohStream(stream);
            throw error;
        }
        if (kind === STREAM_KIND_PING) {
            try {
                const request = Buffer.from(
                    await withDeadline(
                        stream.recv.readToEnd(1),
                        this.#pingTimeoutMs,
                        "The peer did not finish its ping request in time.",
                    ),
                );
                const requestsCapabilities =
                    request.length === 1 && request[0] === PING_CAPABILITIES_VERSION;
                await withDeadline(
                    stream.send.writeAll(
                        requestsCapabilities
                            ? [STREAM_KIND_PING, this.#serveRequest === undefined ? 0 : 1]
                            : [STREAM_KIND_PING],
                    ),
                    this.#pingTimeoutMs,
                    "The peer did not accept its pong in time.",
                );
                await withDeadline(
                    stream.send.finish(),
                    this.#pingTimeoutMs,
                    "The peer did not finish its pong in time.",
                );
            } catch (error) {
                cancelIrohStream(stream);
                throw error;
            }
            return;
        }
        if (
            (kind === STREAM_KIND_HTTP && this.#serveRequest === undefined) ||
            (kind === STREAM_KIND_TUNNEL && this.#serveTunnel === undefined) ||
            (kind !== STREAM_KIND_HTTP && kind !== STREAM_KIND_TUNNEL)
        ) {
            cancelIrohStream(
                stream,
                kind === STREAM_KIND_HTTP || kind === STREAM_KIND_TUNNEL ? 403n : 400n,
            );
            return;
        }
        if (this.#incomingHttpRequestCount >= MAXIMUM_HTTP_REQUESTS) {
            cancelIrohStream(stream, 429n);
            return;
        }
        this.#incomingHttpRequestCount += 1;
        const duplex = createIrohFrameDuplex(stream.recv, stream.send, () =>
            this.#recordPeerActivity(endpointId),
        );
        const controller = new AbortController();
        const abortFromConnection = (): void => controller.abort(connectionSignal.reason);
        if (connectionSignal.aborted) abortFromConnection();
        else connectionSignal.addEventListener("abort", abortFromConnection, { once: true });
        let completed = false;
        try {
            if (kind === STREAM_KIND_TUNNEL) {
                await this.#serveTunnelStream(peerId, duplex, controller);
            } else {
                const request = await withDeadline(
                    readP2pHttpRequest(duplex.recv),
                    REQUEST_BODY_TIMEOUT_MS,
                    "The peer did not finish its HTTP request in time.",
                );
                if (typeof stream.recv.receivedReset === "function") {
                    void stream.recv.receivedReset().then(
                        (errorCode) => {
                            if (errorCode !== null) {
                                controller.abort(new Error("The peer reset the P2P stream."));
                            }
                        },
                        (error: unknown) => controller.abort(error),
                    );
                }
                const response = await withDeadline(
                    this.#serveRequest!(peerId, request, controller.signal),
                    RESPONSE_HEAD_TIMEOUT_MS,
                    "The local daemon did not return HTTP response headers in time.",
                );
                await writeP2pHttpResponse(
                    duplex.send,
                    response,
                    this.#responseWriteProgressTimeoutMs,
                );
            }
            completed = true;
        } catch (error) {
            if (!controller.signal.aborted && !(error instanceof P2pFrameWriteTimeoutError)) {
                if (kind === STREAM_KIND_TUNNEL) {
                    await writeP2pTunnelFailure(
                        duplex.send,
                        error,
                        this.#responseWriteProgressTimeoutMs,
                    ).catch(() => undefined);
                } else {
                    await writeP2pHttpFailure(
                        duplex.send,
                        error,
                        this.#responseWriteProgressTimeoutMs,
                    ).catch(() => undefined);
                }
            }
        } finally {
            connectionSignal.removeEventListener("abort", abortFromConnection);
            controller.abort();
            this.#incomingHttpRequestCount -= 1;
            if (kind === STREAM_KIND_TUNNEL || !completed) cancelIrohStream(stream);
        }
    }

    async #serveTunnelStream(
        peerId: string,
        duplex: ReturnType<typeof createIrohFrameDuplex>,
        controller: AbortController,
    ): Promise<void> {
        const request = await withDeadline(
            readP2pTunnelRequest(duplex.recv),
            REQUEST_BODY_TIMEOUT_MS,
            "The peer did not finish its tunnel request in time.",
        );
        const connection = await withDeadline(
            this.#serveTunnel!(peerId, request, controller.signal),
            RESPONSE_HEAD_TIMEOUT_MS,
            "The local daemon did not open the tunnel in time.",
        );
        await writeP2pTunnelResponse(duplex.send, connection.response);
        if (connection.response.status !== (request.method === "GET" ? 101 : 200)) {
            connection.stream.destroy();
            await finishWrites(duplex.send, this.#responseWriteProgressTimeoutMs);
            return;
        }
        const tunnel = createP2pTunnelStream(duplex, {
            close: () => connection.stream.destroy(),
            signal: controller.signal,
        });
        connection.stream.pipe(tunnel);
        tunnel.pipe(connection.stream);
        await Promise.all([
            finished(connection.stream, { cleanup: true }),
            finished(tunnel, { cleanup: true }),
        ]);
    }

    async #superviseEndpoint(endpoint: Endpoint): Promise<void> {
        let ticket = this.#tryTicketFor(endpoint);
        while (!this.#abort.signal.aborted && this.#endpoint === endpoint) {
            await this.#wait(this.#addressSupervisionIntervalMs);
            if (this.#abort.signal.aborted || this.#endpoint !== endpoint) return;
            const nextTicket = this.#tryTicketFor(endpoint);
            if (nextTicket !== undefined && nextTicket !== ticket) {
                ticket = nextTicket;
                this.#wakeRetries();
            }
        }
    }

    async #restartEndpoint(failedPeerId?: string): Promise<void> {
        if (this.#closed || this.#abort.signal.aborted) return;
        if (this.#endpointFactory === undefined) {
            throw new Error("The Iroh endpoint cannot be rebuilt on this platform.");
        }
        if (this.#endpointRestart !== undefined) return this.#endpointRestart;
        if (this.#httpRequestCount > 0 || this.#incomingHttpRequestCount > 0) {
            throw new IrohEndpointRestartDeferredError(
                "The Iroh endpoint was not rebuilt because a P2P request is still active.",
            );
        }
        if (
            failedPeerId !== undefined &&
            [...this.#peerStatuses].some(
                ([endpointId, status]) =>
                    endpointId !== failedPeerId && status.status === "connected",
            )
        ) {
            throw new IrohEndpointRestartDeferredError(
                "The Iroh endpoint was not rebuilt because another peer is still connected.",
            );
        }
        if (this.#endpointClosePending !== undefined) {
            throw new IrohEndpointRestartDeferredError(
                "The previous Iroh endpoint is still closing.",
            );
        }
        if (
            this.#lastEndpointRestartAt !== 0 &&
            Date.now() - this.#lastEndpointRestartAt < this.#restartCooldownMs
        ) {
            throw new IrohEndpointRestartDeferredError(
                "The Iroh endpoint restart is cooling down.",
            );
        }
        const restart = (async () => {
            const previous = this.#endpoint;
            const endpointId = previous.id().toString();
            for (const [peerId, entry] of this.#outgoingConnections) {
                if (entry.connection !== undefined) {
                    this.#retireOutgoingConnection(peerId, entry, "close");
                }
            }
            for (const connection of this.#authenticatedConnections) {
                connection.close(CLOSE_SHUTDOWN, []);
            }
            this.#authenticatedConnections.clear();
            const closing = previous.close();
            this.#endpointClosePending = closing;
            void closing.then(
                () => {
                    if (this.#endpointClosePending === closing) {
                        this.#endpointClosePending = undefined;
                        this.#wakeRetries();
                    }
                },
                () => {
                    if (this.#endpointClosePending === closing) {
                        this.#endpointClosePending = undefined;
                        this.#wakeRetries();
                    }
                },
            );
            await withDeadline(
                closing,
                this.#closeTimeoutMs,
                "The old Iroh endpoint did not close in time.",
            );
            if (this.#endpointClosePending === closing) this.#endpointClosePending = undefined;
            if (this.#closed || this.#abort.signal.aborted) return;
            const next = await this.#endpointFactory!();
            if (this.#closed || this.#abort.signal.aborted) {
                await next.close().catch(() => undefined);
                return;
            }
            if (next.id().toString() !== endpointId) {
                await next.close().catch(() => undefined);
                throw new Error("The rebuilt Iroh endpoint changed its transport identity.");
            }
            this.#endpoint = next;
            for (const controller of this.#pendingConnectChanges.values()) controller.abort();
            this.#pendingConnectChanges.clear();
            this.#pendingConnects.clear();
            this.#peerDiscoveryProbes.clear();
            this.#lastEndpointRestartAt = Date.now();
            this.#startEndpoint(next);
            this.#wakeRetries();
        })();
        this.#endpointRestart = restart;
        try {
            await restart;
        } finally {
            if (this.#endpointRestart === restart) this.#endpointRestart = undefined;
        }
    }

    async #pingPeer(endpointId: string): Promise<void> {
        let retryMs = INITIAL_RETRY_MS;
        let consecutiveFailures = 0;
        while (!this.#abort.signal.aborted) {
            let shared: IrohSharedConnection | undefined;
            try {
                if (!this.#hasRecentPeerActivity(endpointId)) {
                    this.#setPeerStatus(endpointId, this.#statusFor(endpointId, "connecting"));
                }
                shared = await this.#outgoingConnection(endpointId, this.#abort.signal);
                const authenticated = shared.identity;
                let consecutivePingFailures = 0;
                while (!this.#abort.signal.aborted) {
                    const lastActivityAt = this.#peerLastActivityAt.get(endpointId);
                    if (lastActivityAt !== undefined && this.#peerApiAvailable.has(endpointId)) {
                        const quietForMs = Date.now() - lastActivityAt;
                        if (quietForMs < this.#pingIntervalMs) {
                            consecutiveFailures = 0;
                            consecutivePingFailures = 0;
                            this.#peerNeedsDiscovery.delete(endpointId);
                            retryMs = INITIAL_RETRY_MS;
                            await this.#wait(this.#pingIntervalMs - quietForMs);
                            continue;
                        }
                    }
                    const startedAt = Date.now();
                    const activityRevision = this.#peerActivityRevisions.get(endpointId) ?? 0;
                    let apiExposed: boolean | undefined;
                    try {
                        apiExposed = await exchangePing(shared.connection, this.#pingTimeoutMs);
                        consecutivePingFailures = 0;
                    } catch (error) {
                        if (
                            (this.#peerActivityRevisions.get(endpointId) ?? 0) !== activityRevision
                        ) {
                            consecutiveFailures = 0;
                            consecutivePingFailures = 0;
                            this.#peerNeedsDiscovery.delete(endpointId);
                            retryMs = INITIAL_RETRY_MS;
                            continue;
                        }
                        if (isConnectionClosed(shared.connection)) throw error;
                        consecutivePingFailures += 1;
                        if (consecutivePingFailures >= 2) throw error;
                        await this.#wait(INITIAL_RETRY_MS);
                        continue;
                    }
                    consecutiveFailures = 0;
                    this.#peerNeedsDiscovery.delete(endpointId);
                    retryMs = INITIAL_RETRY_MS;
                    this.#recordPeerActivity(
                        endpointId,
                        Date.now() - startedAt,
                        authenticated,
                        apiExposed,
                    );
                    await this.#wait(this.#pingIntervalMs);
                }
            } catch (error) {
                if (this.#abort.signal.aborted) return;
                if (shared !== undefined) {
                    this.#retireOutgoingConnection(endpointId, shared.entry, "drain");
                }
                consecutiveFailures += 1;
                if (consecutiveFailures >= 2 && this.#peerAddresses.has(endpointId)) {
                    this.#peerNeedsDiscovery.add(endpointId);
                }
                if (!this.#hasRecentPeerActivity(endpointId)) {
                    this.#setPeerStatus(endpointId, {
                        ...this.#statusFor(endpointId, "unreachable"),
                        error: errorToMessage(error),
                    });
                }
                await this.#wait(retryMs);
                retryMs = Math.min(MAXIMUM_RETRY_MS, retryMs * 2);
            }
        }
    }

    async #openPeerStream(
        endpointId: string,
        peerId: string,
        signal: AbortSignal,
        timeoutMessage: string,
    ): Promise<IrohPeerStream> {
        for (let attemptIndex = 0; attemptIndex < 2; attemptIndex += 1) {
            const shared = await this.#outgoingConnection(endpointId, signal);
            if (shared.identity.instanceId !== peerId) {
                this.#retireOutgoingConnection(endpointId, shared.entry, "close");
                throw new Error("The Iroh endpoint belongs to a different P2P instance.");
            }
            let opening: ReturnType<Connection["openBi"]> | undefined;
            try {
                opening = shared.connection.openBi();
                const stream = await withAbort(
                    withDeadline(opening, this.#handshakeTimeoutMs, timeoutMessage),
                    signal,
                );
                shared.entry.activeApplicationStreams += 1;
                return { entry: shared.entry, stream };
            } catch (error) {
                if (opening !== undefined) {
                    void opening.then(cancelIrohStream, () => undefined);
                }
                if (signal.aborted || attemptIndex > 0) throw error;
                this.#retireOutgoingConnection(
                    endpointId,
                    shared.entry,
                    isConnectionClosed(shared.connection) ? "closed" : "drain",
                );
            }
        }
        throw new Error("The Iroh peer connection could not open a stream.");
    }

    async #outgoingConnection(
        endpointId: string,
        signal: AbortSignal,
    ): Promise<IrohSharedConnection> {
        let entry = this.#outgoingConnections.get(endpointId);
        if (entry?.connection !== undefined && isConnectionClosed(entry.connection)) {
            this.#retireOutgoingConnection(endpointId, entry, "closed");
            entry = undefined;
        }
        if (entry === undefined) {
            entry = { activeApplicationStreams: 0 };
            this.#outgoingConnections.set(endpointId, entry);
            entry.promise = this.#establishOutgoingConnection(endpointId, entry);
            void entry.promise.catch(() => undefined);
        }
        return await withAbort(entry.promise!, signal);
    }

    async #establishOutgoingConnection(
        endpointId: string,
        entry: IrohOutgoingConnectionEntry,
    ): Promise<IrohSharedConnection> {
        let connection: Connection | undefined;
        try {
            const connected = await this.#connect(endpointId);
            connection = connected.connection;
            if (connection.remoteId().toString() !== endpointId) {
                throw new Error("Iroh connected to a different endpoint identity.");
            }
            const authenticatedConnection = connection;
            const identity = await this.#withPeerOperation("handshake", async (ctx) => {
                return await this.#authenticateOutgoing(ctx, authenticatedConnection, endpointId);
            });
            if (
                this.#closed ||
                this.#abort.signal.aborted ||
                connected.endpoint !== this.#endpoint ||
                this.#outgoingConnections.get(endpointId) !== entry
            ) {
                throw new Error("Iroh networking stopped before the connection was ready.");
            }
            entry.connection = connection;
            this.#authenticatedConnections.add(connection);
            this.#rememberPeer(endpointId, identity);
            this.#recordPeerActivity(endpointId);
            if (typeof connection.closed === "function") {
                void connection.closed().then(
                    () => this.#retireOutgoingConnection(endpointId, entry, "closed"),
                    () => this.#retireOutgoingConnection(endpointId, entry, "closed"),
                );
            }
            return { connection, entry, identity };
        } catch (error) {
            connection?.close(CLOSE_SHUTDOWN, []);
            this.#retireOutgoingConnection(endpointId, entry, "closed");
            throw error;
        }
    }

    #retireOutgoingConnection(
        endpointId: string,
        entry: IrohOutgoingConnectionEntry,
        mode: "close" | "closed" | "drain",
    ): void {
        const connection = entry.connection;
        if (this.#outgoingConnections.get(endpointId) === entry) {
            this.#outgoingConnections.delete(endpointId);
            this.#wakeRetries();
        }
        if (connection === undefined) return;
        if (
            mode === "drain" &&
            entry.activeApplicationStreams > 0 &&
            !isConnectionClosed(connection)
        ) {
            entry.closeWhenIdle = true;
            return;
        }
        delete entry.connection;
        this.#authenticatedConnections.delete(connection);
        if (mode !== "closed") connection.close(CLOSE_SHUTDOWN, []);
    }

    #releaseOutgoingApplicationStream(entry: IrohOutgoingConnectionEntry): void {
        entry.activeApplicationStreams = Math.max(0, entry.activeApplicationStreams - 1);
        if (!entry.closeWhenIdle || entry.activeApplicationStreams > 0) return;
        delete entry.closeWhenIdle;
        const connection = entry.connection;
        if (connection === undefined) return;
        delete entry.connection;
        this.#authenticatedConnections.delete(connection);
        connection.close(CLOSE_SHUTDOWN, []);
    }

    async #connect(endpointId: string): Promise<IrohConnectedEndpoint> {
        if (
            typeof this.#endpoint.isClosed === "function" &&
            this.#endpoint.isClosed() &&
            !this.#closed
        ) {
            await this.#restartEndpoint();
        }
        let pending = this.#pendingConnects.get(endpointId) ?? new Set();
        this.#pendingConnects.set(endpointId, pending);
        let forceDiscovery = this.#peerNeedsDiscovery.delete(endpointId);
        if (pending.size >= MAXIMUM_STANDARD_CONNECTS_PER_PEER) {
            let pendingChanged = this.#pendingConnectChanges.get(endpointId);
            if (pendingChanged === undefined) {
                pendingChanged = new AbortController();
                this.#pendingConnectChanges.set(endpointId, pendingChanged);
            }
            await waitForAbortOrTimeout(
                [this.#abort.signal, pendingChanged.signal],
                this.#connectTimeoutMs,
            );
            if (this.#abort.signal.aborted) throw new Error("Iroh networking stopped.");
            if (pending.size >= MAXIMUM_STANDARD_CONNECTS_PER_PEER) {
                try {
                    await this.#restartEndpoint(endpointId);
                    pending = new Set();
                    this.#pendingConnects.set(endpointId, pending);
                    this.#peerDiscoveryProbes.delete(endpointId);
                } catch (error) {
                    if (
                        !(error instanceof IrohEndpointRestartDeferredError) ||
                        this.#peerDiscoveryProbes.has(endpointId)
                    ) {
                        throw error;
                    }
                    forceDiscovery = true;
                }
            }
        }
        const endpoint = this.#endpoint;
        if (forceDiscovery) {
            if (this.#peerDiscoveryProbes.has(endpointId)) {
                throw new IrohEndpointRestartDeferredError(
                    "An Iroh discovery attempt is already active for this peer.",
                );
            }
            this.#peerDiscoveryProbes.add(endpointId);
        }
        let attempt: Promise<Connection>;
        try {
            attempt = endpoint.connect(
                forceDiscovery ? this.#discoveryAddress(endpointId) : this.#peerAddress(endpointId),
                IROH_ALPN,
            );
        } catch (error) {
            if (forceDiscovery) this.#peerDiscoveryProbes.delete(endpointId);
            throw error;
        }
        pending.add(attempt);
        const settled = (): void => {
            pending.delete(attempt);
            const pendingChanged = this.#pendingConnectChanges.get(endpointId);
            if (pendingChanged !== undefined) {
                pendingChanged.abort();
                this.#pendingConnectChanges.set(endpointId, new AbortController());
            }
            if (forceDiscovery) {
                this.#peerDiscoveryProbes.delete(endpointId);
                this.#wakeRetries();
            }
        };
        void attempt.then(settled, settled);
        try {
            return {
                connection: await withDeadline(
                    attempt,
                    this.#connectTimeoutMs,
                    "The Iroh connection attempt timed out.",
                ),
                endpoint,
            };
        } catch (error) {
            if (!(error instanceof IrohOperationTimeoutError)) throw error;
            void attempt.then(
                (lateConnection) => lateConnection.close(CLOSE_SHUTDOWN, []),
                () => undefined,
            );
            throw error;
        }
    }

    #peerAddress(endpointId: string): EndpointAddr {
        const configured = this.#peerAddresses.get(endpointId);
        if (configured !== undefined) return configured;
        return new this.#bindings.EndpointAddr(
            this.#bindings.EndpointId.fromString(endpointId),
            this.#config.relayUrl ?? undefined,
        );
    }

    #discoveryAddress(endpointId: string): EndpointAddr {
        return new this.#bindings.EndpointAddr(
            this.#bindings.EndpointId.fromString(endpointId),
            this.#config.relayUrl ?? undefined,
        );
    }

    #setPeerTicket(endpointId: string, ticket: string): void {
        try {
            const address = this.#bindings.EndpointTicket.fromString(ticket).endpointAddr();
            if (address.id().toString() !== endpointId) return;
            this.#peerAddresses.set(endpointId, address);
            this.#peerTickets.set(endpointId, ticket);
        } catch {
            // Address hints are not trust. Ignore a damaged hint and fall back to discovery.
        }
    }

    #ticketFor(endpoint: Endpoint): string {
        return this.#bindings.EndpointTicket.fromAddr(endpoint.addr()).toString();
    }

    #tryTicketFor(endpoint: Endpoint): string | undefined {
        try {
            return this.#ticketFor(endpoint);
        } catch {
            return undefined;
        }
    }

    async #refreshPeerAddress(endpointId: string, identity: P2pPeerIdentity): Promise<void> {
        const endpoint = this.#endpoint;
        if (typeof endpoint.remoteAddr !== "function") return;
        const address = await endpoint.remoteAddr(this.#bindings.EndpointId.fromString(endpointId));
        if (
            address === null ||
            address.id().toString() !== endpointId ||
            endpoint !== this.#endpoint
        ) {
            return;
        }
        const current = this.#peerAddresses.get(endpointId);
        if (current !== undefined && current.relayUrl() !== null && address.relayUrl() === null) {
            return;
        }
        const ticket = this.#bindings.EndpointTicket.fromAddr(address).toString();
        if (ticket.length > 4_096 || this.#peerTickets.get(endpointId) === ticket) return;
        this.#peerAddresses.set(endpointId, address);
        this.#peerTickets.set(endpointId, ticket);
        if (this.#updatePeerAddress !== undefined) {
            await this.#withPeerOperation("address-refresh", async (ctx) => {
                if (ctx === undefined) {
                    throw new Error("Iroh peer address persistence requires an operation context.");
                }
                await this.#updatePeerAddress!(ctx, identity, endpointId, ticket);
            });
        }
    }

    async #authenticateOutgoing(
        ctx: Context | undefined,
        connection: Connection,
        endpointId: string,
    ): Promise<P2pPeerIdentity> {
        const stream = await withDeadline(
            connection.openBi(),
            this.#handshakeTimeoutMs,
            "Rig could not open a signed identity hello in time.",
        );
        await stream.send.writeAll([STREAM_KIND_HELLO]);
        const identity = await runP2pInitiatorHello(
            withFrameProgressDeadline(
                createIrohFrameDuplex(stream.recv, stream.send),
                this.#handshakeTimeoutMs,
                () =>
                    new IrohOperationTimeoutError(
                        "The peer did not finish its signed identity hello in time.",
                    ),
            ),
            {
                commitPeer: (identity, address) =>
                    this.#commitAuthenticatedPeer(ctx, identity, address),
                identity: this.#identity,
                localChannelBinding: this.localAddress(),
                remoteChannelBinding: endpointId,
                transport: "iroh",
                validatePeer: (identity, address) =>
                    this.#validateAuthenticatedPeer(ctx, identity, address),
            },
        );
        await withDeadline(
            stream.recv.readToEnd(0),
            this.#handshakeTimeoutMs,
            "The peer did not finish its signed identity hello stream in time.",
        );
        return identity;
    }

    async #validateAuthenticatedPeer(
        ctx: Context | undefined,
        identity: P2pPeerIdentity,
        endpointId: string,
    ): Promise<void> {
        if (identity.instanceId === this.#identity.instanceId) {
            throw new Error("A P2P transport address cannot identify this Rig instance as a peer.");
        }
        if (this.#validatePeer !== undefined) {
            if (ctx === undefined) {
                throw new Error("Iroh peer validation requires an operation context.");
            }
            await this.#validatePeer(ctx, identity, endpointId);
        }
    }

    async #commitAuthenticatedPeer(
        ctx: Context | undefined,
        identity: P2pPeerIdentity,
        endpointId: string,
    ): Promise<void> {
        if (this.#commitPeer !== undefined) {
            if (ctx === undefined) {
                throw new Error("Iroh peer commit requires an operation context.");
            }
            await this.#commitPeer(ctx, identity, endpointId);
        }
    }

    #rememberPeer(endpointId: string, identity: P2pPeerIdentity): void {
        this.#peerIdentities.set(endpointId, identity);
        this.#track(this.#refreshPeerAddress(endpointId, identity).catch(() => undefined));
        const previous = this.#peerStatuses.get(endpointId);
        this.#setPeerStatus(endpointId, {
            address: endpointId,
            ...(previous?.error === undefined ? {} : { error: previous.error }),
            ...(previous?.lastSeenAt === undefined ? {} : { lastSeenAt: previous.lastSeenAt }),
            name: this.#peerName(endpointId),
            peerId: identity.instanceId,
            publicKey: identity.publicKey,
            ...(previous?.rttMs === undefined ? {} : { rttMs: previous.rttMs }),
            status: previous?.status ?? "connecting",
        });
    }

    async #withPeerOperation<Result>(
        operation: "address-refresh" | "handshake",
        work: (ctx: Context | undefined) => Result | PromiseLike<Result>,
    ): Promise<Awaited<Result>> {
        if (this.#runPeerOperation === undefined) return await work(undefined);
        return await this.#runPeerOperation(operation, work);
    }

    #endpointForPeer(peerId: string): string {
        let best: { endpointId: string; rank: number } | undefined;
        for (const endpointId of this.#endpointIds) {
            if (this.#peerIdentities.get(endpointId)?.instanceId !== peerId) continue;
            const status = this.#peerStatuses.get(endpointId)?.status;
            const rank = status === "connected" ? 2 : status === "connecting" ? 1 : 0;
            if (best === undefined || rank > best.rank) best = { endpointId, rank };
        }
        if (best !== undefined) return best.endpointId;
        throw new Error("No trusted Iroh endpoint is pinned to that P2P instance.");
    }

    #statusFor(endpointId: string, status: P2pPeerStatus["status"]): P2pPeerStatus {
        const identity = this.#peerIdentities.get(endpointId);
        return {
            address: endpointId,
            name: this.#peerName(endpointId),
            ...(identity === undefined
                ? {}
                : { peerId: identity.instanceId, publicKey: identity.publicKey }),
            status,
        };
    }

    #peerName(endpointId: string): string {
        const name = this.#peerNames.get(endpointId);
        if (name === undefined) {
            throw new Error("The configured Iroh peer has no trusted display name.");
        }
        return name;
    }

    #hasRecentPeerActivity(endpointId: string): boolean {
        const lastActivityAt = this.#peerLastActivityAt.get(endpointId);
        return lastActivityAt !== undefined && Date.now() - lastActivityAt < this.#pingIntervalMs;
    }

    #recordPeerActivity(
        endpointId: string,
        rttMs?: number,
        authenticated = this.#peerIdentities.get(endpointId),
        apiExposed?: boolean,
    ): void {
        if (authenticated === undefined) return;
        if (apiExposed !== undefined) this.#peerApiAvailable.set(endpointId, apiExposed);
        const now = Date.now();
        this.#peerActivityRevisions.set(
            endpointId,
            (this.#peerActivityRevisions.get(endpointId) ?? 0) + 1,
        );
        this.#peerLastActivityAt.set(endpointId, now);
        const previous = this.#peerStatuses.get(endpointId);
        const statusChanged =
            previous?.status !== "connected" ||
            previous.error !== undefined ||
            previous.name !== this.#peerName(endpointId);
        this.#setPeerStatus(endpointId, {
            address: endpointId,
            lastSeenAt: now,
            name: this.#peerName(endpointId),
            peerId: authenticated.instanceId,
            publicKey: authenticated.publicKey,
            ...(rttMs === undefined
                ? previous?.rttMs === undefined
                    ? {}
                    : { rttMs: previous.rttMs }
                : { rttMs }),
            status: "connected",
        });
        const lastPublishedAt = this.#peerLastActivityPublishedAt.get(endpointId) ?? 0;
        if (statusChanged) {
            this.#peerLastActivityPublishedAt.set(endpointId, now);
        } else if (now - lastPublishedAt >= this.#pingIntervalMs) {
            this.#peerLastActivityPublishedAt.set(endpointId, now);
            this.#publishStatus();
        }
    }

    #setPeerStatus(endpointId: string, status: P2pPeerStatus): void {
        const previous = this.#peerStatuses.get(endpointId);
        if (
            previous?.status === status.status &&
            previous.address === status.address &&
            previous.error === status.error &&
            previous.lastSeenAt === status.lastSeenAt &&
            previous.name === status.name &&
            previous.peerId === status.peerId &&
            previous.publicKey === status.publicKey &&
            previous.rttMs === status.rttMs
        ) {
            return;
        }
        this.#peerStatuses.set(endpointId, status);
        if (
            previous?.status !== status.status ||
            previous.error !== status.error ||
            previous.name !== status.name
        ) {
            this.#publishStatus();
        }
    }

    #publishStatus(): void {
        try {
            this.#onStatusChange?.(this.status());
        } catch {
            // A UI notification must never break peer authentication or the ping loop.
        }
    }

    #track(task: Promise<void>): void {
        this.#tasks.add(task);
        void task.then(
            () => this.#tasks.delete(task),
            () => this.#tasks.delete(task),
        );
    }

    #wakeRetries(): void {
        this.#retryWake.abort();
        this.#retryWake = new AbortController();
    }

    #wait(ms: number): Promise<void> {
        return new Promise((resolve) => {
            if (this.#abort.signal.aborted) return resolve();
            const retryWake = this.#retryWake.signal;
            const finish = () => {
                clearTimeout(timer);
                this.#abort.signal.removeEventListener("abort", finish);
                retryWake.removeEventListener("abort", finish);
                resolve();
            };
            const timer = setTimeout(finish, ms);
            this.#abort.signal.addEventListener("abort", finish, { once: true });
            retryWake.addEventListener("abort", finish, { once: true });
        });
    }
}

type IrohModule = typeof import("@number0/iroh/index.js");
type IrohBindings = Pick<
    IrohModule,
    "Endpoint" | "EndpointAddr" | "EndpointId" | "EndpointTicket" | "RelayMode"
>;

class IrohOperationTimeoutError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "IrohOperationTimeoutError";
    }
}

class IrohEndpointRestartDeferredError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "IrohEndpointRestartDeferredError";
    }
}

async function exchangePing(
    connection: Connection,
    timeoutMs: number,
): Promise<boolean | undefined> {
    let stream: Awaited<ReturnType<Connection["openBi"]>> | undefined;
    let opening: ReturnType<Connection["openBi"]> | undefined;
    try {
        opening = connection.openBi();
        stream = await withDeadline(
            opening,
            timeoutMs,
            "The peer did not open a ping stream in time.",
        );
        await withDeadline(
            stream.send.writeAll([STREAM_KIND_PING, PING_CAPABILITIES_VERSION]),
            timeoutMs,
            "The peer did not accept a ping in time.",
        );
        await withDeadline(
            stream.send.finish(),
            timeoutMs,
            "The peer did not finish a ping request in time.",
        );
        const response = Buffer.from(
            await withDeadline(
                stream.recv.readToEnd(16),
                timeoutMs,
                "The peer did not answer its ping in time.",
            ),
        );
        if (response.length === 1 && response[0] === STREAM_KIND_PING) return undefined;
        if (
            response.length !== 2 ||
            response[0] !== STREAM_KIND_PING ||
            (response[1] !== 0 && response[1] !== 1)
        ) {
            throw new Error("The peer returned an invalid pong.");
        }
        return response[1] === 1;
    } catch (error) {
        if (stream !== undefined) cancelIrohStream(stream);
        else if (opening !== undefined) void opening.then(cancelIrohStream, () => undefined);
        throw error;
    }
}

function cancelIrohStream(
    stream: Awaited<ReturnType<Connection["openBi"]>>,
    errorCode = CLOSE_CANCELLED,
): void {
    void stream.send.reset(errorCode).catch(() => undefined);
    void stream.recv.stop(errorCode).catch(() => undefined);
}

async function finishIrohHttpStream(
    stream: Awaited<ReturnType<Connection["openBi"]>>,
    timeoutMs: number,
): Promise<void> {
    try {
        await Promise.all([
            withDeadline(
                stream.send.finish(),
                timeoutMs,
                "The peer did not finish the P2P request stream in time.",
            ),
            withDeadline(
                stream.recv.readToEnd(0),
                timeoutMs,
                "The peer did not finish the P2P response stream in time.",
            ),
        ]);
    } catch {
        cancelIrohStream(stream);
    }
}

function isConnectionClosed(connection: Connection): boolean {
    return typeof connection.closeReason === "function" && connection.closeReason() !== null;
}

function withDeadline<T>(operation: Promise<T>, timeoutMs: number, message: string): Promise<T> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new IrohOperationTimeoutError(message)), timeoutMs);
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

function withAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise((resolve, reject) => {
        if (signal.aborted) return reject(signal.reason);
        const abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        void operation.then(
            (value) => {
                signal.removeEventListener("abort", abort);
                resolve(value);
            },
            (error: unknown) => {
                signal.removeEventListener("abort", abort);
                reject(error);
            },
        );
    });
}
