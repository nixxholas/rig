import type { P2pPeerTrustStoreContract } from "./P2pPeerTrustStore.js";
import type { P2pTrustedPeer } from "./P2pPeer.js";

export async function recoverP2pPairings(
    ctx: Context,
    peerTrustStore: P2pPeerTrustStoreContract,
    setPrimaryIfUnset: (primaryId: string) => Promise<void>,
): Promise<readonly P2pTrustedPeer[]> {
    const recovered: P2pTrustedPeer[] = [];
    const errors: unknown[] = [];
    for (const pending of await peerTrustStore.readyPairings(ctx)) {
        try {
            const peer = await pending.activate(ctx);
            if (pending.pairing.assignPrimary) {
                await setPrimaryIfUnset(pending.pairing.peer.instanceId);
            }
            await pending.complete(ctx);
            recovered.push(peer);
        } catch (error) {
            errors.push(error);
        }
    }
    if (errors.length > 0) {
        throw new AggregateError(errors, "Rig could not finish every confirmed P2P pairing.");
    }
    return recovered;
}
import type { Context } from "@steve.kite/stdlib";
