import { and, asc, eq, inArray, lt, or } from "drizzle-orm";
import { Value } from "@sinclair/typebox/value";

import { p2pPeerPairingTrustSchema, type P2pPeerPairingTrust } from "../../p2p/P2pPeer.js";
import { p2pPeerPairings } from "../database/schema.js";
import { inDatabase } from "../database/inDatabase.js";
import { inTx } from "../inTx.js";
import type { DatabaseScope } from "../Transaction.js";
import { queryP2pPeers } from "./queryP2pPeers.js";

export type P2pPeerPairingConfirmResult =
    | "already_confirmed"
    | "missing"
    | "not_local_ready"
    | "updated";

export type P2pPeerPairingLocalReadyResult = "already_ready" | "missing" | "updated";

export type P2pPeerPairingCompleteResult = "completed" | "missing" | "not_active" | "not_confirmed";

export async function queryP2pPeerPairings(
    tx: DatabaseScope,
): Promise<readonly P2pPeerPairingTrust[]> {
    return await inDatabase(tx, async (tx) => {
        return (
            await tx.select().from(p2pPeerPairings).orderBy(asc(p2pPeerPairings.pairingId)).all()
        ).map(readPairing);
    });
}

export async function createP2pPeerPairing(
    tx: DatabaseScope,
    pairing: P2pPeerPairingTrust,
): Promise<void> {
    if (!Value.Check(p2pPeerPairingTrustSchema, pairing)) {
        throw new Error("The P2P pairing transaction is invalid.");
    }
    await inDatabase(tx, async (tx) => {
        await tx
            .insert(p2pPeerPairings)
            .values({
                assignPrimary: pairing.assignPrimary,
                bindingsJson: JSON.stringify(pairing.peer.bindings),
                connectionsJson: JSON.stringify(pairing.peer.connections),
                expiresAtMs: pairing.expiresAt,
                instanceId: pairing.peer.instanceId,
                name: pairing.peer.name,
                pairingId: pairing.pairingId,
                publicKey: pairing.peer.publicKey,
                state: pairing.state,
            })
            .run();
    });
}

export async function deleteExpiredP2pPeerPairings(tx: DatabaseScope, now: number): Promise<void> {
    await inDatabase(tx, async (tx) => {
        await tx
            .delete(p2pPeerPairings)
            .where(
                and(
                    or(
                        eq(p2pPeerPairings.state, "prepared"),
                        eq(p2pPeerPairings.state, "local_ready"),
                    ),
                    lt(p2pPeerPairings.expiresAtMs, now),
                ),
            )
            .run();
    });
}

export async function abortP2pPeerPairing(tx: DatabaseScope, pairingId: string): Promise<void> {
    await inDatabase(tx, async (tx) => {
        await tx
            .delete(p2pPeerPairings)
            .where(
                and(
                    eq(p2pPeerPairings.pairingId, pairingId),
                    inArray(p2pPeerPairings.state, ["prepared", "local_ready"]),
                ),
            )
            .run();
    });
}

export async function markP2pPeerPairingLocallyReady(
    tx: DatabaseScope,
    pairingId: string,
): Promise<P2pPeerPairingLocalReadyResult> {
    return await inTx(tx, async (tx) => {
        const current = (await queryP2pPeerPairings(tx)).find(
            (pairing) => pairing.pairingId === pairingId,
        );
        if (current === undefined) return "missing";
        if (current.state === "confirmed" || current.state === "local_ready") {
            return "already_ready";
        }
        await tx
            .update(p2pPeerPairings)
            .set({ state: "local_ready" })
            .where(eq(p2pPeerPairings.pairingId, pairingId))
            .run();
        return "updated";
    });
}

export async function confirmP2pPeerPairing(
    tx: DatabaseScope,
    pairingId: string,
): Promise<P2pPeerPairingConfirmResult> {
    return await inTx(tx, async (tx) => {
        const current = (await queryP2pPeerPairings(tx)).find(
            (pairing) => pairing.pairingId === pairingId,
        );
        if (current === undefined) return "missing";
        if (current.state === "confirmed") return "already_confirmed";
        if (current.state !== "local_ready") return "not_local_ready";
        await tx
            .update(p2pPeerPairings)
            .set({ state: "confirmed" })
            .where(eq(p2pPeerPairings.pairingId, pairingId))
            .run();
        return "updated";
    });
}

export async function completeP2pPeerPairing(
    tx: DatabaseScope,
    pairingId: string,
): Promise<P2pPeerPairingCompleteResult> {
    return await inTx(tx, async (tx) => {
        const pending = (await queryP2pPeerPairings(tx)).find(
            (pairing) => pairing.pairingId === pairingId,
        );
        if (pending === undefined) return "missing";
        if (pending.state !== "confirmed") return "not_confirmed";
        const active = (await queryP2pPeers(tx)).find(
            (peer) =>
                peer.instanceId === pending.peer.instanceId &&
                peer.publicKey === pending.peer.publicKey,
        );
        if (active === undefined) return "not_active";
        await tx.delete(p2pPeerPairings).where(eq(p2pPeerPairings.pairingId, pairingId)).run();
        return "completed";
    });
}

function readPairing(row: typeof p2pPeerPairings.$inferSelect): P2pPeerPairingTrust {
    const candidate: unknown = {
        assignPrimary: row.assignPrimary,
        expiresAt: row.expiresAtMs,
        pairingId: row.pairingId,
        peer: {
            bindings: JSON.parse(row.bindingsJson) as unknown,
            connections: JSON.parse(row.connectionsJson) as unknown,
            instanceId: row.instanceId,
            name: row.name,
            publicKey: row.publicKey,
        },
        state: row.state,
    };
    if (!Value.Check(p2pPeerPairingTrustSchema, candidate)) {
        throw new Error("The saved P2P pairing transaction is invalid.");
    }
    return candidate;
}
