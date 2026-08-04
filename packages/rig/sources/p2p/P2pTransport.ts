import type { P2pTransportStatus } from "../protocol/P2pProtocol.js";

export type P2pTransportKind = "iroh";

export interface P2pTransport {
    readonly kind: P2pTransportKind;
    close(): Promise<void>;
    status(): P2pTransportStatus;
}
