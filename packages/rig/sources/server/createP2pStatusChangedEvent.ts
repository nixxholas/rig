import type { P2pStatus, P2pStatusChangedEvent } from "../protocol/index.js";
import { projectP2pApiStatus } from "./projectP2pApiStatus.js";

export function createP2pStatusChangedEvent(
    status: P2pStatus,
    peerApiAvailable: (peerId: string) => boolean,
    id: string,
    createdAt: number = Date.now(),
): P2pStatusChangedEvent {
    return {
        createdAt,
        data: { status: projectP2pApiStatus(status, peerApiAvailable) },
        id,
        type: "p2p_status_changed",
    };
}
