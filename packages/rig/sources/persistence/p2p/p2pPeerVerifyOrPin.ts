import type { Context } from "@steve.kite/stdlib";

import { eq } from "drizzle-orm";
import { Value } from "@sinclair/typebox/value";

import { p2pPeerIdentitySchema, type P2pPeerIdentity } from "../../p2p/P2pIdentity.js";
import {
    p2pPeerNameSchema,
    type P2pPeerConnections,
    type P2pTransportBinding,
} from "../../p2p/P2pPeer.js";
import { inTx } from "../inTx.js";
import { p2pPeers } from "../database/schema.js";
import { queryP2pPeers } from "./queryP2pPeers.js";

export async function p2pPeerVerifyOrPin(
    ctx: Context,
    identity: P2pPeerIdentity,
    binding: P2pTransportBinding | undefined,
    connections: P2pPeerConnections | undefined,
    name: string | undefined,
    now: number,
): Promise<void> {
    const normalized = { instanceId: identity.instanceId, publicKey: identity.publicKey };
    if (!Value.Check(p2pPeerIdentitySchema, normalized)) {
        throw new Error("The peer presented an invalid P2P identity.");
    }
    if (name !== undefined && !Value.Check(p2pPeerNameSchema, name)) {
        throw new Error("The peer presented an invalid P2P name.");
    }
    await inTx(ctx, "rig.sql.p2p.p2pPeerVerifyOrPin", async (ctx) => {
        const tx = ctx.tx;
        const peers = await queryP2pPeers(ctx);
        const byInstance = peers.find((peer) => peer.instanceId === identity.instanceId);
        if (byInstance !== undefined && byInstance.publicKey !== identity.publicKey) {
            throw new Error("The peer's stable P2P identity key does not match its pin.");
        }
        const byPublicKey = peers.find((peer) => peer.publicKey === identity.publicKey);
        if (byPublicKey !== undefined && byPublicKey.instanceId !== identity.instanceId) {
            throw new Error("The peer's P2P public key is pinned to another instance.");
        }
        if (binding !== undefined) {
            const byBinding = peers.find((peer) =>
                peer.bindings.some(
                    (candidate) =>
                        candidate.transport === binding.transport &&
                        candidate.address === binding.address,
                ),
            );
            if (byBinding !== undefined && byBinding.instanceId !== identity.instanceId) {
                throw new Error("The transport address is pinned to another P2P instance.");
            }
        }
        if (byInstance === undefined) {
            if (name === undefined) {
                throw new Error("A new trusted P2P peer must have a display name.");
            }
            await tx
                .insert(p2pPeers)
                .values({
                    bindingsJson: JSON.stringify(binding === undefined ? [] : [binding]),
                    connectionsJson: JSON.stringify(connections ?? {}),
                    createdAtMs: now,
                    instanceId: identity.instanceId,
                    name,
                    publicKey: identity.publicKey,
                    updatedAtMs: now,
                })
                .run();
            return;
        }
        const bindings =
            binding === undefined ||
            byInstance.bindings.some(
                (candidate) =>
                    candidate.transport === binding.transport &&
                    candidate.address === binding.address,
            )
                ? byInstance.bindings
                : [...byInstance.bindings, binding];
        const nextConnections = { ...byInstance.connections, ...connections };
        const nextName = name ?? byInstance.name;
        if (
            bindings === byInstance.bindings &&
            JSON.stringify(nextConnections) === JSON.stringify(byInstance.connections) &&
            nextName === byInstance.name
        ) {
            return;
        }
        await tx
            .update(p2pPeers)
            .set({
                bindingsJson: JSON.stringify(bindings),
                connectionsJson: JSON.stringify(nextConnections),
                name: nextName,
                updatedAtMs: now,
            })
            .where(eq(p2pPeers.instanceId, identity.instanceId))
            .run();
    });
}
