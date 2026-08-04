import type {
    Connection,
    Endpoint,
    EndpointAddr,
    RelayMode,
    SecretKey,
} from "@number0/iroh/index.js";

import type { ConfigIrohTransport } from "../config/types.js";
import { errorToMessage } from "../errorToMessage.js";
import type { P2pPeerStatus, P2pTransportStatus } from "../protocol/P2pProtocol.js";
import {
    IrohHttpWriteTimeoutError,
    readIrohHttpRequest,
    readIrohHttpResponse,
    writeIrohHttpFailure,
    writeIrohHttpRequest,
    writeIrohHttpResponse,
} from "./IrohHttpProtocol.js";
import { loadIrohBindings } from "./loadIrohBindings.js";
import type { P2pHttpRequest, P2pHttpResponse, ServeP2pHttpRequest } from "./P2pHttp.js";
import type { P2pTransport } from "./P2pTransport.js";

const IROH_ALPN = [...Buffer.from("rig/p2p/2", "utf8")];
const STREAM_KIND_PING = 1;
const STREAM_KIND_HTTP = 2;
const PONG = Buffer.from([STREAM_KIND_PING]);
const CLOSE_UNAUTHORIZED = 403n;
const CLOSE_SHUTDOWN = 0n;
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 5_000;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 5_000;
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
const DEFAULT_PING_INTERVAL_MS = 10_000;
const DEFAULT_PING_TIMEOUT_MS = 5_000;
const INITIAL_RETRY_MS = 250;
const MAXIMUM_PENDING_CONNECTS_PER_PEER = 2;
const MAXIMUM_HTTP_REQUESTS = 32;
const MAXIMUM_RETRY_MS = 10_000;
const REQUEST_BODY_TIMEOUT_MS = 120_000;
const RESPONSE_HEAD_TIMEOUT_MS = 30_000;
const RESPONSE_WRITE_PROGRESS_TIMEOUT_MS = 30_000;

export interface CreateIrohNetworkOptions {
    /** Test seam. Production dynamically loads the platform's native Iroh binding. */
    bindings?: IrohBindings;
    closeTimeoutMs?: number;
    config: ConfigIrohTransport;
    connectTimeoutMs?: number;
    handshakeTimeoutMs?: number;
    idleTimeoutMs?: number;
    secretKey: SecretKey;
    /** Test seam for a pre-bound relay-free endpoint. */
    endpoint?: Endpoint;
    /** Test seam for direct, relay-free endpoint addresses. */
    peerAddresses?: ReadonlyMap<string, EndpointAddr>;
    /** Test seam. Production uses Iroh's n0 relay and discovery preset. */
    relayMode?: RelayMode;
    pingIntervalMs?: number;
    pingTimeoutMs?: number;
    responseWriteProgressTimeoutMs?: number;
    serveRequest?: ServeP2pHttpRequest;
    onStatusChange?: (status: P2pTransportStatus) => void;
}

export class IrohNetwork implements P2pTransport {
    readonly kind = "iroh";
    readonly #abort = new AbortController();
    readonly #allowedPeers: ReadonlySet<string>;
    readonly #bindings: IrohBindings;
    readonly #closeTimeoutMs: number;
    readonly #config: ConfigIrohTransport;
    readonly #connectTimeoutMs: number;
    readonly #endpoint: Endpoint;
    readonly #handshakeTimeoutMs: number;
    readonly #idleTimeoutMs: number;
    readonly #onStatusChange: ((status: P2pTransportStatus) => void) | undefined;
    readonly #pendingConnects = new Map<string, Set<Promise<Connection>>>();
    readonly #peerAddresses: ReadonlyMap<string, EndpointAddr>;
    readonly #peerStatuses = new Map<string, P2pPeerStatus>();
    readonly #pingIntervalMs: number;
    readonly #pingTimeoutMs: number;
    readonly #responseWriteProgressTimeoutMs: number;
    readonly #serveRequest: ServeP2pHttpRequest | undefined;
    readonly #tasks = new Set<Promise<void>>();
    readonly #httpConnections = new Set<Connection>();
    #httpRequestCount = 0;
    #incomingHttpRequestCount = 0;
    #closed = false;

    private constructor(
        endpoint: Endpoint,
        bindings: IrohBindings,
        options: CreateIrohNetworkOptions,
    ) {
        this.#bindings = bindings;
        this.#endpoint = endpoint;
        this.#config = options.config;
        this.#closeTimeoutMs = options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS;
        this.#connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
        this.#handshakeTimeoutMs = options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
        this.#allowedPeers = new Set(options.config.trustedEndpointIds);
        this.#peerAddresses = options.peerAddresses ?? new Map();
        this.#pingIntervalMs = options.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS;
        this.#idleTimeoutMs = Math.max(
            options.idleTimeoutMs ?? 0,
            DEFAULT_IDLE_TIMEOUT_MS,
            this.#pingIntervalMs * 3,
        );
        this.#pingTimeoutMs = options.pingTimeoutMs ?? DEFAULT_PING_TIMEOUT_MS;
        this.#responseWriteProgressTimeoutMs =
            options.responseWriteProgressTimeoutMs ?? RESPONSE_WRITE_PROGRESS_TIMEOUT_MS;
        this.#serveRequest = options.serveRequest;
        this.#onStatusChange = options.onStatusChange;
        for (const endpointId of options.config.trustedEndpointIds) {
            this.#peerStatuses.set(endpointId, { peerId: endpointId, status: "connecting" });
        }
    }

    static async create(options: CreateIrohNetworkOptions): Promise<IrohNetwork> {
        const bindings = options.bindings ?? (await loadIrohBindings());
        const relayMode =
            options.relayMode ??
            (options.config.relayUrl === undefined
                ? bindings.RelayMode.defaultMode()
                : bindings.RelayMode.customFromUrls([options.config.relayUrl]));
        const endpoint =
            options.endpoint ??
            (await bindings.Endpoint.bind(
                { alpns: [IROH_ALPN], secretKey: options.secretKey.toBytes() },
                relayMode,
            ));
        if (options.config.trustedEndpointIds.includes(endpoint.id().toString())) {
            await endpoint.close();
            throw new Error(
                "p2p.iroh.trusted_endpoint_ids must not contain this daemon's own endpoint ID.",
            );
        }
        const network = new IrohNetwork(endpoint, bindings, options);
        network.#start();
        return network;
    }

    localId(): string {
        return this.#endpoint.id().toString();
    }

    status(): Extract<P2pTransportStatus, { state: "ready" }> {
        return {
            apiExposed: this.#serveRequest !== undefined,
            localId: this.localId(),
            peers: this.#config.trustedEndpointIds.map((endpointId) => ({
                ...this.#peerStatuses.get(endpointId)!,
            })),
            ...(this.#config.relayUrl === undefined ? {} : { relayUrl: this.#config.relayUrl }),
            state: "ready",
            transport: "iroh",
        };
    }

    async fetch(
        peerId: string,
        request: P2pHttpRequest,
        signal: AbortSignal,
    ): Promise<P2pHttpResponse> {
        if (!this.#allowedPeers.has(peerId)) {
            throw new Error("That endpoint ID is not trusted by the Iroh transport.");
        }
        if (this.#httpRequestCount >= MAXIMUM_HTTP_REQUESTS) {
            throw new Error("Too many P2P HTTP requests are already active.");
        }
        this.#httpRequestCount += 1;
        let connection: Connection | undefined;
        let released = false;
        const release = (): void => {
            if (released) return;
            released = true;
            signal.removeEventListener("abort", abort);
            if (connection !== undefined) {
                this.#httpConnections.delete(connection);
                connection.close(CLOSE_SHUTDOWN, []);
            }
            this.#httpRequestCount -= 1;
        };
        const abort = (): void => release();
        try {
            signal.throwIfAborted();
            connection = await connectOnce(
                this.#endpoint,
                this.#peerAddress(peerId),
                this.#connectTimeoutMs,
                signal,
            );
            if (connection.remoteId().toString() !== peerId) {
                throw new Error("Iroh connected to a different endpoint identity.");
            }
            this.#httpConnections.add(connection);
            signal.addEventListener("abort", abort, { once: true });
            const stream = await withAbort(
                withDeadline(
                    connection.openBi(),
                    this.#handshakeTimeoutMs,
                    "The peer did not open an HTTP stream in time.",
                ),
                signal,
            );
            await withAbort(stream.send.writeAll([STREAM_KIND_HTTP]), signal);
            await withAbort(
                withDeadline(
                    writeIrohHttpRequest(stream.send, request),
                    REQUEST_BODY_TIMEOUT_MS,
                    "The P2P HTTP request took too long to send.",
                ),
                signal,
            );
            return await withAbort(
                withDeadline(
                    readIrohHttpResponse(stream.recv, release),
                    RESPONSE_HEAD_TIMEOUT_MS,
                    "The peer did not return HTTP response headers in time.",
                ),
                signal,
            );
        } catch (error) {
            release();
            throw error;
        }
    }

    async close(): Promise<void> {
        if (this.#closed) return;
        this.#closed = true;
        this.#abort.abort();
        for (const connection of this.#httpConnections) {
            connection.close(CLOSE_SHUTDOWN, []);
        }
        await Promise.allSettled([
            withDeadline(
                this.#endpoint.close(),
                this.#closeTimeoutMs,
                "The Iroh endpoint did not close in time.",
            ),
            withDeadline(
                Promise.allSettled([...this.#tasks]),
                this.#closeTimeoutMs,
                "Iroh networking tasks did not stop in time.",
            ),
        ]);
    }

    #start(): void {
        this.#track(this.#acceptConnections());
        for (const endpointId of this.#config.trustedEndpointIds) {
            this.#track(this.#pingPeer(endpointId));
        }
        this.#publishStatus();
    }

    async #acceptConnections(): Promise<void> {
        let retryMs = INITIAL_RETRY_MS;
        while (!this.#abort.signal.aborted) {
            try {
                const incoming = await this.#endpoint.acceptNext();
                if (incoming === null) return;
                retryMs = INITIAL_RETRY_MS;
                this.#track(this.#acceptConnection(incoming));
            } catch {
                if (!this.#abort.signal.aborted) await this.#wait(retryMs);
                retryMs = Math.min(MAXIMUM_RETRY_MS, retryMs * 2);
            }
        }
    }

    async #acceptConnection(
        incoming: NonNullable<Awaited<ReturnType<Endpoint["acceptNext"]>>>,
    ): Promise<void> {
        let connection: Connection | undefined;
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
            connection.setMaxConcurrentBiStreams(BigInt(MAXIMUM_HTTP_REQUESTS));
            await this.#serveConnection(connection, remoteId);
        } catch {
            connection?.close(CLOSE_SHUTDOWN, []);
        }
    }

    async #serveConnection(connection: Connection, peerId: string): Promise<void> {
        const streams = new Set<Promise<void>>();
        try {
            while (!this.#abort.signal.aborted) {
                if (streams.size >= MAXIMUM_HTTP_REQUESTS) {
                    await Promise.race(streams);
                    continue;
                }
                const stream = await withDeadline(
                    connection.acceptBi(),
                    this.#idleTimeoutMs,
                    "The peer did not open a P2P stream in time.",
                );
                const serving = this.#serveStream(connection, peerId, stream).catch(
                    () => undefined,
                );
                streams.add(serving);
                void serving.then(
                    () => streams.delete(serving),
                    () => streams.delete(serving),
                );
            }
        } finally {
            await Promise.allSettled([...streams]);
        }
    }

    async #serveStream(
        connection: Connection,
        peerId: string,
        stream: Awaited<ReturnType<Connection["acceptBi"]>>,
    ): Promise<void> {
        const kind = (
            await withDeadline(
                stream.recv.readExact(1),
                this.#pingTimeoutMs,
                "The peer did not identify its P2P request in time.",
            )
        )[0];
        if (kind === STREAM_KIND_PING) {
            await stream.send.writeAll([...PONG]);
            await stream.send.finish();
            return;
        }
        if (kind !== STREAM_KIND_HTTP || this.#serveRequest === undefined) {
            await stream.send.reset(kind === STREAM_KIND_HTTP ? 403n : 400n);
            return;
        }
        if (this.#incomingHttpRequestCount >= MAXIMUM_HTTP_REQUESTS) {
            await stream.send.reset(429n);
            return;
        }
        this.#incomingHttpRequestCount += 1;
        const controller = new AbortController();
        void connection.closed().then(
            () => controller.abort(),
            () => controller.abort(),
        );
        try {
            const request = await withDeadline(
                readIrohHttpRequest(stream.recv),
                REQUEST_BODY_TIMEOUT_MS,
                "The peer did not finish its HTTP request in time.",
            );
            const response = await withDeadline(
                this.#serveRequest(peerId, request, controller.signal),
                RESPONSE_HEAD_TIMEOUT_MS,
                "The local daemon did not return HTTP response headers in time.",
            );
            await writeIrohHttpResponse(
                stream.send,
                response,
                this.#responseWriteProgressTimeoutMs,
            );
        } catch (error) {
            if (!controller.signal.aborted && !(error instanceof IrohHttpWriteTimeoutError)) {
                await writeIrohHttpFailure(
                    stream.send,
                    error,
                    this.#responseWriteProgressTimeoutMs,
                ).catch(() => undefined);
            }
        } finally {
            controller.abort();
            this.#incomingHttpRequestCount -= 1;
            connection.close(CLOSE_SHUTDOWN, []);
        }
    }

    async #pingPeer(endpointId: string): Promise<void> {
        let retryMs = INITIAL_RETRY_MS;
        while (!this.#abort.signal.aborted) {
            let connection: Connection | undefined;
            try {
                this.#setPeerStatus(endpointId, { peerId: endpointId, status: "connecting" });
                connection = await this.#connect(endpointId);
                if (connection.remoteId().toString() !== endpointId) {
                    throw new Error("Iroh connected to a different endpoint identity.");
                }
                retryMs = INITIAL_RETRY_MS;
                while (!this.#abort.signal.aborted) {
                    const startedAt = Date.now();
                    await withDeadline(
                        exchangePing(connection),
                        this.#pingTimeoutMs,
                        "The peer did not answer its ping in time.",
                    );
                    this.#setPeerStatus(endpointId, {
                        lastSeenAt: Date.now(),
                        peerId: endpointId,
                        rttMs: Date.now() - startedAt,
                        status: "connected",
                    });
                    await this.#wait(this.#pingIntervalMs);
                }
            } catch (error) {
                if (this.#abort.signal.aborted) return;
                this.#setPeerStatus(endpointId, {
                    error: errorToMessage(error),
                    peerId: endpointId,
                    status: "unreachable",
                });
                await this.#wait(retryMs);
                retryMs = Math.min(MAXIMUM_RETRY_MS, retryMs * 2);
            } finally {
                connection?.close(CLOSE_SHUTDOWN, []);
            }
        }
    }

    async #connect(endpointId: string): Promise<Connection> {
        const pending = this.#pendingConnects.get(endpointId) ?? new Set();
        this.#pendingConnects.set(endpointId, pending);
        if (pending.size >= MAXIMUM_PENDING_CONNECTS_PER_PEER) {
            await settleAnyOrAbort(pending, this.#abort.signal);
            if (this.#abort.signal.aborted) throw new Error("Iroh networking stopped.");
        }
        const attempt = this.#endpoint.connect(this.#peerAddress(endpointId), IROH_ALPN);
        pending.add(attempt);
        void attempt.then(
            () => pending.delete(attempt),
            () => pending.delete(attempt),
        );
        try {
            return await withDeadline(
                attempt,
                this.#connectTimeoutMs,
                "The Iroh connection attempt timed out.",
            );
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

    #setPeerStatus(endpointId: string, status: P2pPeerStatus): void {
        const previous = this.#peerStatuses.get(endpointId);
        if (
            previous?.status === status.status &&
            previous.error === status.error &&
            previous.lastSeenAt === status.lastSeenAt &&
            previous.rttMs === status.rttMs
        ) {
            return;
        }
        this.#peerStatuses.set(endpointId, status);
        if (previous?.status !== status.status || previous.error !== status.error) {
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

    #wait(ms: number): Promise<void> {
        return new Promise((resolve) => {
            if (this.#abort.signal.aborted) return resolve();
            const finish = () => {
                clearTimeout(timer);
                this.#abort.signal.removeEventListener("abort", finish);
                resolve();
            };
            const timer = setTimeout(finish, ms);
            this.#abort.signal.addEventListener("abort", finish, { once: true });
        });
    }
}

type IrohModule = typeof import("@number0/iroh/index.js");
type IrohBindings = Pick<IrohModule, "Endpoint" | "EndpointAddr" | "EndpointId" | "RelayMode">;

class IrohOperationTimeoutError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "IrohOperationTimeoutError";
    }
}

async function exchangePing(connection: Connection): Promise<void> {
    const stream = await connection.openBi();
    await stream.send.writeAll([STREAM_KIND_PING]);
    await stream.send.finish();
    const response = Buffer.from(await stream.recv.readToEnd(16));
    if (!response.equals(PONG)) throw new Error("The peer returned an invalid pong.");
}

async function connectOnce(
    endpoint: Endpoint,
    address: EndpointAddr,
    timeoutMs: number,
    signal: AbortSignal,
): Promise<Connection> {
    const attempt = endpoint.connect(address, IROH_ALPN);
    try {
        return await withAbort(
            withDeadline(attempt, timeoutMs, "The Iroh connection attempt timed out."),
            signal,
        );
    } catch (error) {
        void attempt.then(
            (lateConnection) => lateConnection.close(CLOSE_SHUTDOWN, []),
            () => undefined,
        );
        throw error;
    }
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

function settleAnyOrAbort(
    operations: ReadonlySet<Promise<Connection>>,
    signal: AbortSignal,
): Promise<void> {
    return new Promise((resolve) => {
        if (signal.aborted) return resolve();
        const finish = () => {
            signal.removeEventListener("abort", finish);
            resolve();
        };
        for (const operation of operations) void operation.then(finish, finish);
        signal.addEventListener("abort", finish, { once: true });
    });
}
