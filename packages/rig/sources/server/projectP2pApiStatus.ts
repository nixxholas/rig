import type { P2pStatus } from "../protocol/index.js";

export function projectP2pApiStatus(
    status: P2pStatus,
    peerApiAvailable: ((peerId: string) => boolean) | undefined,
    excludedPeerId?: string,
): P2pStatus {
    if (peerApiAvailable === undefined && excludedPeerId === undefined) return status;
    return {
        ...status,
        transports: status.transports.map((transport) =>
            transport.state === "ready"
                ? {
                      ...transport,
                      peers: transport.peers.filter(
                          (peer) =>
                              peer.peerId !== excludedPeerId &&
                              (peerApiAvailable === undefined ||
                                  (peer.peerId !== undefined && peerApiAvailable(peer.peerId))),
                      ),
                  }
                : transport,
        ),
    };
}
