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
import { loadIrohBindings } from "./loadIrohBindings.js";
import type { P2pTransport } from "./P2pTransport.js";

const IROH_ALPN = [...Buffer.from("rig/p2p/1", "utf8")];
const PING = [...Buffer.from("ping", "utf8")];
const PONG = Buffer.from("pong", "utf8");
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
const MAXIMUM_RETRY_MS = 10_000;

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
    readonly #tasks = new Set<Promise<void>>();
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
            localId: this.localId(),
            peers: this.#config.trustedEndpointIds.map((endpointId) => ({
                ...this.#peerStatuses.get(endpointId)!,
            })),
            ...(this.#config.relayUrl === undefined ? {} : { relayUrl: this.#config.relayUrl }),
            state: "ready",
            transport: "iroh",
        };
    }

    async close(): Promise<void> {
        if (this.#closed) return;
        this.#closed = true;
        this.#abort.abort();
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
            await this.#serveConnection(connection);
        } catch {
            connection?.close(CLOSE_SHUTDOWN, []);
        }
    }

    async #serveConnection(connection: Connection): Promise<void> {
        while (!this.#abort.signal.aborted) {
            const stream = await withDeadline(
                connection.acceptBi(),
                this.#idleTimeoutMs,
                "The peer did not open a ping stream in time.",
            );
            const request = Buffer.from(
                await withDeadline(
                    stream.recv.readToEnd(16),
                    this.#pingTimeoutMs,
                    "The peer did not finish its ping request in time.",
                ),
            );
            if (!request.equals(Buffer.from(PING))) {
                await stream.send.reset(400n);
                continue;
            }
            await stream.send.writeAll([...PONG]);
            await stream.send.finish();
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
    await stream.send.writeAll(PING);
    await stream.send.finish();
    const response = Buffer.from(await stream.recv.readToEnd(16));
    if (!response.equals(PONG)) throw new Error("The peer returned an invalid pong.");
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
