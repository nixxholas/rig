import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";

import type { TX } from "../persistence/Transaction.js";
import { inDatabase } from "../persistence/database/inDatabase.js";
import { withDatabase } from "../persistence/database/databaseContext.js";
import { inTx } from "../persistence/inTx.js";
import {
    abortP2pPeerPairing,
    completeP2pPeerPairing,
    confirmP2pPeerPairing,
    createP2pPeerPairing,
    deleteExpiredP2pPeerPairings,
    markP2pPeerPairingLocallyReady,
    queryP2pPeerPairings,
} from "../persistence/p2p/p2pPeerPairing.js";
import { p2pPeerValidate } from "../persistence/p2p/p2pPeerValidate.js";
import { p2pPeerVerifyOrPin } from "../persistence/p2p/p2pPeerVerifyOrPin.js";
import { queryP2pPeers } from "../persistence/p2p/queryP2pPeers.js";
import type { P2pPeerIdentity } from "./P2pIdentity.js";
import {
    p2pPairingTransactionIdSchema,
    type P2pPeerConnections,
    type P2pPeerPairingTrust,
    type P2pTransportBinding,
    type P2pTrustedPeer,
} from "./P2pPeer.js";
import type { P2pTransportKind } from "./P2pTransport.js";

export interface P2pPeerTrustDatabase {
    query<T>(ctx: Context, operation: (ctx: Context) => Promise<T>): Promise<T>;
    transaction<T>(ctx: Context, operation: (ctx: Context) => Promise<T>): Promise<T>;
}

export interface P2pPeerTrustStoreContract {
    preparePairing(
        ctx: Context,
        pairingId: string,
        identity: P2pPeerIdentity,
        transport: P2pTransportKind,
        address: string,
        connections: P2pPeerConnections,
        name: string,
        assignPrimary: boolean,
        expiresAt: number,
    ): Promise<P2pPreparedPairingTrust>;
    peers(ctx: Context): Promise<readonly P2pTrustedPeer[]>;
    peerForBinding(
        ctx: Context,
        transport: P2pTransportKind,
        address: string,
    ): Promise<P2pPeerIdentity | undefined>;
    validate(
        ctx: Context,
        identity: P2pPeerIdentity,
        transport?: P2pTransportKind,
        address?: string,
    ): Promise<void>;
    verifyOrPin(
        ctx: Context,
        identity: P2pPeerIdentity,
        transport?: P2pTransportKind,
        address?: string,
        connections?: P2pPeerConnections,
        name?: string,
    ): Promise<void>;
    readyPairings(ctx: Context): Promise<readonly P2pPreparedPairingTrust[]>;
}

export interface P2pPreparedPairingTrust {
    pairing: P2pPeerPairingTrust;
    activate(ctx: Context): Promise<P2pTrustedPeer>;
    abort(ctx: Context): Promise<void>;
    complete(ctx: Context): Promise<void>;
    markConfirmed(ctx: Context): Promise<void>;
    markLocallyReady(ctx: Context): Promise<void>;
}

export class P2pPeerTrustStore implements P2pPeerTrustStoreContract {
    readonly #database: P2pPeerTrustDatabase;
    readonly #now: () => number;

    constructor(database: P2pPeerTrustDatabase, options: { now?: () => number } = {}) {
        this.#database = database;
        this.#now = options.now ?? Date.now;
    }

    static fromDatabase(database: TX, options: { now?: () => number } = {}): P2pPeerTrustStore {
        return new P2pPeerTrustStore(
            {
                query: (ctx, operation) =>
                    inDatabase(
                        withDatabase(ctx, database),
                        "rig.sql.p2p.store.query",
                        async (ctx) => operation(ctx),
                    ),
                transaction: (ctx, operation) =>
                    inTx(
                        withDatabase(ctx, database),
                        "rig.sql.p2p.store.transaction",
                        async (ctx) => operation(ctx),
                    ),
            },
            options,
        );
    }

    async peers(ctx: Context): Promise<readonly P2pTrustedPeer[]> {
        return this.#database.transaction(ctx, async (ctx) => {
            await deleteExpiredP2pPeerPairings(ctx, this.#now());
            return queryP2pPeers(ctx);
        });
    }

    async preparePairing(
        ctx: Context,
        pairingId: string,
        identity: P2pPeerIdentity,
        transport: P2pTransportKind,
        address: string,
        connections: P2pPeerConnections,
        name: string,
        assignPrimary: boolean,
        expiresAt: number,
    ): Promise<P2pPreparedPairingTrust> {
        if (!Value.Check(p2pPairingTransactionIdSchema, pairingId)) {
            throw new Error("The P2P pairing transaction ID is invalid.");
        }
        let pairing: P2pPeerPairingTrust | undefined;
        await this.#database.transaction(ctx, async (ctx) => {
            await deleteExpiredP2pPeerPairings(ctx, this.#now());
            await p2pPeerValidate(ctx, identity, { address, transport });
            const candidate: P2pPeerPairingTrust = {
                assignPrimary,
                expiresAt,
                pairingId,
                peer: {
                    bindings: [{ address, transport }],
                    connections,
                    instanceId: identity.instanceId,
                    name,
                    publicKey: identity.publicKey,
                },
                state: "prepared",
            };
            const existing = (await queryP2pPeerPairings(ctx)).find(
                (entry) => entry.pairingId === pairingId,
            );
            if (existing !== undefined) {
                if (!samePairing(existing, candidate)) {
                    throw new Error("The P2P pairing transaction ID is already in use.");
                }
                pairing = existing;
                return;
            }
            await createP2pPeerPairing(ctx, candidate);
            pairing = candidate;
        });
        if (pairing === undefined) {
            throw new Error("The P2P pairing trust transaction was not prepared.");
        }
        return this.#handle(pairing);
    }

    async readyPairings(ctx: Context): Promise<readonly P2pPreparedPairingTrust[]> {
        return this.#database.transaction(ctx, async (ctx) => {
            await deleteExpiredP2pPeerPairings(ctx, this.#now());
            return (await queryP2pPeerPairings(ctx))
                .filter((pairing) => pairing.state === "confirmed")
                .map((pairing) => this.#handle(pairing));
        });
    }

    async peerForBinding(
        ctx: Context,
        transport: P2pTransportKind,
        address: string,
    ): Promise<P2pPeerIdentity | undefined> {
        const peer = (await this.peers(ctx)).find((candidate) =>
            candidate.bindings.some(
                (binding) => binding.transport === transport && binding.address === address,
            ),
        );
        return peer === undefined
            ? undefined
            : { instanceId: peer.instanceId, publicKey: peer.publicKey };
    }

    async validate(
        ctx: Context,
        identity: P2pPeerIdentity,
        transport?: P2pTransportKind,
        address?: string,
    ): Promise<void> {
        const binding = toBinding(transport, address);
        await this.#database.transaction(ctx, async (ctx) =>
            p2pPeerValidate(ctx, identity, binding),
        );
    }

    async verifyOrPin(
        ctx: Context,
        identity: P2pPeerIdentity,
        transport?: P2pTransportKind,
        address?: string,
        connections?: P2pPeerConnections,
        name?: string,
    ): Promise<void> {
        const binding = toBinding(transport, address);
        await this.#database.transaction(ctx, async (ctx) =>
            p2pPeerVerifyOrPin(ctx, identity, binding, connections, name, this.#now()),
        );
    }

    #handle(pairing: P2pPeerPairingTrust): P2pPreparedPairingTrust {
        return {
            pairing,
            activate: async (ctx) => {
                let peer: P2pTrustedPeer | undefined;
                await this.#database.transaction(ctx, async (ctx) => {
                    const pending = (await queryP2pPeerPairings(ctx)).find(
                        (entry) => entry.pairingId === pairing.pairingId,
                    );
                    if (pending === undefined) {
                        peer = (await queryP2pPeers(ctx)).find(
                            (entry) =>
                                entry.instanceId === pairing.peer.instanceId &&
                                entry.publicKey === pairing.peer.publicKey,
                        );
                        return;
                    }
                    if (pending.state !== "confirmed") {
                        throw new Error("The P2P pairing transaction is not ready to activate.");
                    }
                    const binding = pending.peer.bindings[0];
                    if (binding === undefined) {
                        throw new Error("The P2P pairing transaction has no transport binding.");
                    }
                    await p2pPeerVerifyOrPin(
                        ctx,
                        pending.peer,
                        binding,
                        pending.peer.connections,
                        pending.peer.name,
                        this.#now(),
                    );
                    peer = (await queryP2pPeers(ctx)).find(
                        (entry) => entry.instanceId === pending.peer.instanceId,
                    );
                });
                if (peer === undefined) {
                    throw new Error("The P2P pairing transaction did not activate its peer.");
                }
                return peer;
            },
            abort: async (ctx) => {
                await this.#database.transaction(ctx, async (ctx) =>
                    abortP2pPeerPairing(ctx, pairing.pairingId),
                );
            },
            complete: async (ctx) => {
                await this.#database.transaction(ctx, async (ctx) => {
                    const result = await completeP2pPeerPairing(ctx, pairing.pairingId);
                    if (result === "not_confirmed") {
                        throw new Error("The P2P pairing transaction is not ready to complete.");
                    }
                    if (result === "not_active") {
                        throw new Error(
                            "The P2P pairing transaction cannot complete before trust is active.",
                        );
                    }
                });
            },
            markConfirmed: async (ctx) => {
                await this.#database.transaction(ctx, async (ctx) => {
                    const result = await confirmP2pPeerPairing(ctx, pairing.pairingId);
                    if (result === "missing") {
                        throw new Error("The P2P pairing transaction no longer exists.");
                    }
                    if (result === "not_local_ready") {
                        throw new Error(
                            "The P2P pairing transaction is not locally ready to confirm.",
                        );
                    }
                });
            },
            markLocallyReady: async (ctx) => {
                await this.#database.transaction(ctx, async (ctx) => {
                    const result = await markP2pPeerPairingLocallyReady(ctx, pairing.pairingId);
                    if (result === "missing") {
                        throw new Error("The P2P pairing transaction no longer exists.");
                    }
                });
            },
        };
    }
}

function samePairing(left: P2pPeerPairingTrust, right: P2pPeerPairingTrust): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
}

function toBinding(
    transport: P2pTransportKind | undefined,
    address: string | undefined,
): P2pTransportBinding | undefined {
    if (transport === undefined && address === undefined) return undefined;
    if (transport === undefined || address === undefined) {
        throw new Error("A verified P2P transport binding needs both its kind and address.");
    }
    return { address, transport };
}
