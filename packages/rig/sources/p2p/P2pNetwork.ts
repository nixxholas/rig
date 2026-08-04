import type { ConfigP2p } from "../config/types.js";
import type { P2pStatus, P2pTransportStatus } from "../protocol/P2pProtocol.js";
import { IrohNetwork } from "./IrohNetwork.js";
import { loadOrCreateIrohSecretKey } from "./loadOrCreateIrohSecretKey.js";
import { loadOrCreateP2pIdentity } from "./loadOrCreateP2pIdentity.js";
import { P2pPeerTrustStore } from "./P2pPeerTrustStore.js";
import type { P2pInstanceIdentity } from "./P2pIdentity.js";
import type { P2pHttpRequest, P2pHttpResponse, ServeP2pHttpRequest } from "./P2pHttp.js";
import type { P2pTransport, P2pTransportKind } from "./P2pTransport.js";

export interface CreateP2pNetworkOptions {
    config: ConfigP2p;
    /** Test seam. Production creates the native Iroh transport. */
    createIrohTransport?: (
        onStatusChange: (status: P2pTransportStatus) => void,
    ) => Promise<P2pTransport>;
    irohSecretKeyPath: string;
    identity?: P2pInstanceIdentity;
    identityPath?: string;
    onStatusChange?: (status: P2pStatus) => void;
    onTransportUnavailable?: (transport: P2pTransportKind, error: unknown) => void;
    peerTrustPath?: string;
    peerTrustStore?: P2pPeerTrustStore;
    serveRequest?: ServeP2pHttpRequest;
}

export class P2pNetwork {
    readonly #statuses: Map<P2pTransportKind, P2pTransportStatus>;
    readonly #transports: readonly P2pTransport[];
    readonly #identity: P2pInstanceIdentity | undefined;

    private constructor(
        transports: readonly P2pTransport[],
        statuses: Map<P2pTransportKind, P2pTransportStatus>,
        identity: P2pInstanceIdentity | undefined,
    ) {
        this.#transports = transports;
        this.#statuses = statuses;
        this.#identity = identity;
    }

    static async create(options: CreateP2pNetworkOptions): Promise<P2pNetwork> {
        const statuses = new Map<P2pTransportKind, P2pTransportStatus>();
        const transports: P2pTransport[] = [];
        let identity: P2pInstanceIdentity | undefined;
        const publish = (): void => {
            try {
                options.onStatusChange?.(createStatus(statuses, identity));
            } catch {
                // Optional status delivery must not break a transport.
            }
        };

        try {
            identity =
                options.identity ??
                (await loadOrCreateP2pIdentity(
                    options.identityPath ?? `${options.irohSecretKeyPath}.instance`,
                ));
        } catch (error) {
            if (options.config.enableIroh) {
                statuses.set("iroh", {
                    error:
                        error instanceof Error
                            ? error.message
                            : "The stable P2P identity could not be loaded.",
                    state: "unavailable",
                    transport: "iroh",
                });
                try {
                    options.onTransportUnavailable?.("iroh", error);
                } catch {
                    // Optional diagnostics must not break the P2P service.
                }
            }
            const network = new P2pNetwork(transports, statuses, undefined);
            publish();
            return network;
        }

        if (options.config.enableIroh) {
            const kind = "iroh";
            try {
                const trustStore =
                    options.peerTrustStore ??
                    (await P2pPeerTrustStore.open(
                        options.peerTrustPath ?? `${options.irohSecretKeyPath}.peers`,
                    ));
                const onIrohStatusChange = (status: P2pTransportStatus): void => {
                    statuses.set(kind, status);
                    publish();
                };
                const iroh =
                    options.createIrohTransport === undefined
                        ? await IrohNetwork.create({
                              commitPeer: (peerIdentity, endpointId) =>
                                  trustStore.verifyOrPin(peerIdentity, "iroh", endpointId),
                              config: options.config.iroh,
                              identity,
                              knownPeer: (endpointId) =>
                                  trustStore.peerForBinding("iroh", endpointId),
                              onStatusChange: onIrohStatusChange,
                              secretKey: await loadOrCreateIrohSecretKey(options.irohSecretKeyPath),
                              ...(options.config.exposeApi && options.serveRequest !== undefined
                                  ? { serveRequest: options.serveRequest }
                                  : {}),
                              validatePeer: (peerIdentity, endpointId) =>
                                  trustStore.validate(peerIdentity, "iroh", endpointId),
                          })
                        : await options.createIrohTransport(onIrohStatusChange);
                transports.push(iroh);
                statuses.set(iroh.kind, iroh.status());
            } catch (error) {
                statuses.set(kind, {
                    error: error instanceof Error ? error.message : "Iroh could not start.",
                    state: "unavailable",
                    transport: kind,
                });
                try {
                    options.onTransportUnavailable?.(kind, error);
                } catch {
                    // Optional diagnostics must not break the P2P service.
                }
            }
        }

        const network = new P2pNetwork(transports, statuses, identity);
        publish();
        return network;
    }

    async close(): Promise<void> {
        await Promise.allSettled(this.#transports.map((transport) => transport.close()));
    }

    async fetch(
        peerId: string,
        request: P2pHttpRequest,
        signal: AbortSignal,
    ): Promise<{ response: P2pHttpResponse; transport: P2pTransportKind }> {
        const transport = this.#transports
            .map((candidate) => {
                const status = candidate.status();
                const peer =
                    status.state === "ready"
                        ? status.peers.find((entry) => entry.peerId === peerId)
                        : undefined;
                return {
                    candidate,
                    rank:
                        peer?.status === "connected"
                            ? 2
                            : peer?.status === "connecting"
                              ? 1
                              : peer === undefined
                                ? -1
                                : 0,
                };
            })
            .filter(({ candidate, rank }) => candidate.fetch !== undefined && rank >= 0)
            .sort((left, right) => right.rank - left.rank)[0]?.candidate;
        if (transport?.fetch === undefined) {
            throw new Error("No active P2P transport owns that trusted peer ID.");
        }
        return {
            response: await transport.fetch(peerId, request, signal),
            transport: transport.kind,
        };
    }

    status(): P2pStatus {
        return createStatus(this.#statuses, this.#identity);
    }
}

function createStatus(
    statuses: ReadonlyMap<P2pTransportKind, P2pTransportStatus>,
    identity: P2pInstanceIdentity | undefined,
): P2pStatus {
    return {
        ...(identity === undefined
            ? {}
            : { instanceId: identity.instanceId, publicKey: identity.publicKey }),
        transports: [...statuses.values()],
    };
}
