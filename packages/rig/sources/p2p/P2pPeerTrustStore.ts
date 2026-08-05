import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";

import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import {
    p2pInstanceIdSchema,
    p2pPeerIdentitySchema,
    p2pPublicKeySchema,
    type P2pPeerIdentity,
} from "./P2pIdentity.js";
import type { P2pTransportKind } from "./P2pTransport.js";

const transportBindingSchema = Type.Object(
    {
        address: Type.String({ maxLength: 512, minLength: 1 }),
        transport: Type.Union([Type.Literal("direct"), Type.Literal("iroh"), Type.Literal("ssh")]),
    },
    { additionalProperties: false },
);
type TransportBinding = Static<typeof transportBindingSchema>;

const trustedPeerSchema = Type.Object(
    {
        bindings: Type.Array(transportBindingSchema),
        instanceId: p2pInstanceIdSchema,
        publicKey: p2pPublicKeySchema,
    },
    { additionalProperties: false },
);
type TrustedPeer = Static<typeof trustedPeerSchema>;

const trustFileSchema = Type.Object(
    {
        peers: Type.Array(trustedPeerSchema),
        version: Type.Literal(1),
    },
    { additionalProperties: false },
);
type TrustFile = Static<typeof trustFileSchema>;

export class P2pPeerTrustStore {
    readonly #path: string;
    readonly #peers = new Map<string, TrustedPeer>();
    #mutation: Promise<void> = Promise.resolve();

    private constructor(path: string, file: TrustFile) {
        this.#path = path;
        const publicKeys = new Set<string>();
        const bindings = new Set<string>();
        for (const peer of file.peers) {
            if (this.#peers.has(peer.instanceId) || publicKeys.has(peer.publicKey)) {
                throw new Error("The saved P2P peer trust store contains conflicting identities.");
            }
            publicKeys.add(peer.publicKey);
            for (const binding of peer.bindings) {
                const key = `${binding.transport}\0${binding.address}`;
                if (bindings.has(key)) {
                    throw new Error(
                        "The saved P2P peer trust store contains conflicting transport bindings.",
                    );
                }
                bindings.add(key);
            }
            this.#peers.set(peer.instanceId, {
                ...peer,
                bindings: [...peer.bindings],
            });
        }
    }

    static async open(path: string): Promise<P2pPeerTrustStore> {
        await mkdir(dirname(path), { mode: 0o700, recursive: true });
        return new P2pPeerTrustStore(path, await readTrustFile(path));
    }

    peerForBinding(transport: P2pTransportKind, address: string): P2pPeerIdentity | undefined {
        for (const peer of this.#peers.values()) {
            if (
                peer.bindings.some(
                    (binding) => binding.transport === transport && binding.address === address,
                )
            ) {
                return { instanceId: peer.instanceId, publicKey: peer.publicKey };
            }
        }
        return undefined;
    }

    validate(
        identity: P2pPeerIdentity,
        transport: P2pTransportKind,
        address: string,
    ): Promise<void> {
        return this.#mutation.then(() => {
            this.#assertCompatible(identity, transport, address);
        });
    }

    verifyOrPin(
        identity: P2pPeerIdentity,
        transport: P2pTransportKind,
        address: string,
    ): Promise<void> {
        const run = this.#mutation.then(async () => {
            const peerIdentity = this.#assertCompatible(identity, transport, address);
            const byInstance = this.#peers.get(peerIdentity.instanceId);
            const binding: TransportBinding = { address, transport };
            if (byInstance === undefined) {
                this.#peers.set(peerIdentity.instanceId, {
                    bindings: [binding],
                    ...peerIdentity,
                });
                try {
                    await this.#persist();
                } catch (error) {
                    this.#peers.delete(peerIdentity.instanceId);
                    throw error;
                }
                return;
            }
            if (
                !byInstance.bindings.some(
                    (existing) => existing.transport === transport && existing.address === address,
                )
            ) {
                byInstance.bindings.push(binding);
                try {
                    await this.#persist();
                } catch (error) {
                    byInstance.bindings.pop();
                    throw error;
                }
            }
        });
        this.#mutation = run.catch(() => undefined);
        return run;
    }

    #assertCompatible(
        identity: P2pPeerIdentity,
        transport: P2pTransportKind,
        address: string,
    ): P2pPeerIdentity {
        const peerIdentity: P2pPeerIdentity = {
            instanceId: identity.instanceId,
            publicKey: identity.publicKey,
        };
        if (!Value.Check(p2pPeerIdentitySchema, peerIdentity)) {
            throw new Error("The peer presented an invalid P2P identity.");
        }
        const byInstance = this.#peers.get(peerIdentity.instanceId);
        if (byInstance !== undefined && byInstance.publicKey !== peerIdentity.publicKey) {
            throw new Error("The peer's stable P2P identity key does not match its pin.");
        }
        for (const peer of this.#peers.values()) {
            if (
                peer.publicKey === peerIdentity.publicKey &&
                peer.instanceId !== peerIdentity.instanceId
            ) {
                throw new Error("The peer's P2P public key is pinned to another instance.");
            }
            if (
                peer.instanceId !== peerIdentity.instanceId &&
                peer.bindings.some(
                    (binding) => binding.transport === transport && binding.address === address,
                )
            ) {
                throw new Error("The transport address is pinned to another P2P instance.");
            }
        }
        return peerIdentity;
    }

    async #persist(): Promise<void> {
        const file: TrustFile = {
            peers: [...this.#peers.values()]
                .map((peer) => ({
                    ...peer,
                    bindings: [...peer.bindings].sort(
                        (left, right) =>
                            left.transport.localeCompare(right.transport) ||
                            left.address.localeCompare(right.address),
                    ),
                }))
                .sort((left, right) => left.instanceId.localeCompare(right.instanceId)),
            version: 1,
        };
        const temporaryPath = `${this.#path}.${randomUUID()}.tmp`;
        let temporary;
        try {
            temporary = await open(
                temporaryPath,
                constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
                0o600,
            );
            await temporary.writeFile(`${JSON.stringify(file)}\n`, "utf8");
            await temporary.sync();
            await temporary.close();
            temporary = undefined;
            await rename(temporaryPath, this.#path);
        } finally {
            await temporary?.close();
            await rm(temporaryPath, { force: true });
        }
    }
}

async function readTrustFile(path: string): Promise<TrustFile> {
    let file;
    try {
        file = await open(path, constants.O_NOFOLLOW | constants.O_RDONLY);
    } catch (error) {
        if (isMissingFile(error)) return { peers: [], version: 1 };
        throw error;
    }
    try {
        await file.chmod(0o600);
        const parsed: unknown = JSON.parse(await file.readFile("utf8"));
        if (!Value.Check(trustFileSchema, parsed)) {
            throw new Error("The saved P2P peer trust store is invalid.");
        }
        return parsed;
    } finally {
        await file.close();
    }
}

function isMissingFile(error: unknown): boolean {
    return error instanceof Error && "code" in error && error.code === "ENOENT";
}
