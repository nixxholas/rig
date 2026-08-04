import type { ConfigP2p } from "../config/types.js";
import type { P2pStatus, P2pTransportStatus } from "../protocol/P2pProtocol.js";
import { IrohNetwork } from "./IrohNetwork.js";
import { loadOrCreateIrohSecretKey } from "./loadOrCreateIrohSecretKey.js";
import type { P2pTransport, P2pTransportKind } from "./P2pTransport.js";

export interface CreateP2pNetworkOptions {
    config: ConfigP2p;
    /** Test seam. Production creates the native Iroh transport. */
    createIrohTransport?: (
        onStatusChange: (status: P2pTransportStatus) => void,
    ) => Promise<P2pTransport>;
    irohSecretKeyPath: string;
    onStatusChange?: (status: P2pStatus) => void;
    onTransportUnavailable?: (transport: P2pTransportKind, error: unknown) => void;
}

export class P2pNetwork {
    readonly #statuses: Map<P2pTransportKind, P2pTransportStatus>;
    readonly #transports: readonly P2pTransport[];

    private constructor(
        transports: readonly P2pTransport[],
        statuses: Map<P2pTransportKind, P2pTransportStatus>,
    ) {
        this.#transports = transports;
        this.#statuses = statuses;
    }

    static async create(options: CreateP2pNetworkOptions): Promise<P2pNetwork> {
        const statuses = new Map<P2pTransportKind, P2pTransportStatus>();
        const transports: P2pTransport[] = [];
        const publish = (): void => {
            try {
                options.onStatusChange?.(createStatus(statuses));
            } catch {
                // Optional status delivery must not break a transport.
            }
        };

        if (options.config.enableIroh) {
            const kind = "iroh";
            try {
                const onIrohStatusChange = (status: P2pTransportStatus): void => {
                    statuses.set(kind, status);
                    publish();
                };
                const iroh =
                    options.createIrohTransport === undefined
                        ? await IrohNetwork.create({
                              config: options.config.iroh,
                              onStatusChange: onIrohStatusChange,
                              secretKey: await loadOrCreateIrohSecretKey(options.irohSecretKeyPath),
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

        const network = new P2pNetwork(transports, statuses);
        publish();
        return network;
    }

    async close(): Promise<void> {
        await Promise.allSettled(this.#transports.map((transport) => transport.close()));
    }

    status(): P2pStatus {
        return createStatus(this.#statuses);
    }
}

function createStatus(statuses: ReadonlyMap<P2pTransportKind, P2pTransportStatus>): P2pStatus {
    return { transports: [...statuses.values()] };
}
