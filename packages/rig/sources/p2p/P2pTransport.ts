import type { P2pTransportStatus } from "../protocol/P2pProtocol.js";
import type { P2pHttpRequest, P2pHttpResponse } from "./P2pHttp.js";

export type P2pTransportKind = "iroh";

export interface P2pTransport {
    readonly kind: P2pTransportKind;
    close(): Promise<void>;
    fetch?(peerId: string, request: P2pHttpRequest, signal: AbortSignal): Promise<P2pHttpResponse>;
    status(): P2pTransportStatus;
}
