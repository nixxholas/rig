import { describe, expect, it, vi } from "vitest";

import { createP2pInstanceIdentity } from "../p2p/P2pIdentity.js";
import type { P2pNetwork } from "../p2p/P2pNetwork.js";
import { PersistentSessionStore } from "../session/PersistentSessionStore.js";
import { P2pCredentialStore, P2pCredentialVersionConflictError } from "./P2pCredentialStore.js";
import { P2pCredentialReplicator } from "./P2pCredentialReplicator.js";

describe("P2pCredentialReplicator", () => {
    it("reports request-time synchronization failures without rejecting the request preflight", async () => {
        const local = createP2pInstanceIdentity(
            "alocalinstance00000000001",
            new Uint8Array(32).fill(1),
        );
        const remote = createP2pInstanceIdentity(
            "aremoteinstance0000000001",
            new Uint8Array(32).fill(2),
        );
        const failure = new Error("peer is temporarily unavailable");
        const onError = vi.fn();
        const store = new P2pCredentialStore({
            database: {
                query: <T>() => [] as T,
                transaction: <T>() => false as T,
            },
            identity: local,
        });
        const replicator = new P2pCredentialReplicator({
            listPeers: () => [{ instanceId: remote.instanceId, publicKey: remote.publicKey }],
            network: {
                fetch: vi.fn(async () => {
                    throw failure;
                }),
            } as unknown as P2pNetwork,
            onError,
            snapshot: () => snapshot(local, "secret", 1),
            store,
        });

        await expect(replicator.ensureForRequest(remote.instanceId)).resolves.toBeUndefined();
        expect(onError).toHaveBeenCalledWith(remote.instanceId, failure);
        await replicator.close();
    });

    it("proactively renews changed access leases without overlapping timers and stops on close", async () => {
        vi.useFakeTimers();
        try {
            const local = createP2pInstanceIdentity(
                "alocalinstance00000000001",
                new Uint8Array(32).fill(1),
            );
            const remote = createP2pInstanceIdentity(
                "aremoteinstance0000000001",
                new Uint8Array(32).fill(2),
            );
            let currentSnapshot = snapshot(local, "lease-one", 1);
            const fetch = vi.fn(async () =>
                response(200, { changed: true, version: currentSnapshot.version }),
            );
            const store = new P2pCredentialStore({
                database: {
                    query: <T>() => [] as T,
                    transaction: <T>() => false as T,
                },
                identity: local,
            });
            const replicator = new P2pCredentialReplicator({
                listPeers: () => [{ instanceId: remote.instanceId, publicKey: remote.publicKey }],
                network: { fetch } as unknown as P2pNetwork,
                snapshot: () => currentSnapshot,
                store,
            });

            await replicator.ensure(remote.instanceId);
            currentSnapshot = snapshot(local, "lease-two", 2);
            await vi.advanceTimersByTimeAsync(4 * 60 * 1_000);
            expect(fetch).toHaveBeenCalledTimes(2);

            await vi.advanceTimersByTimeAsync(4 * 60 * 1_000);
            expect(fetch).toHaveBeenCalledTimes(2);

            await replicator.close();
            expect(vi.getTimerCount()).toBe(0);
            currentSnapshot = snapshot(local, "lease-three", 3);
            await vi.advanceTimersByTimeAsync(8 * 60 * 1_000);
            expect(fetch).toHaveBeenCalledTimes(2);
        } finally {
            vi.useRealTimers();
        }
    });

    it("uploads once per snapshot and resynchronizes after a peer change", async () => {
        const local = createP2pInstanceIdentity(
            "alocalinstance00000000001",
            new Uint8Array(32).fill(1),
        );
        const remote = createP2pInstanceIdentity(
            "aremoteinstance0000000001",
            new Uint8Array(32).fill(2),
        );
        const requests: unknown[] = [];
        const fetch = vi.fn(async (_peerId: string, request: unknown) => {
            requests.push(request);
            return {
                response: {
                    body: (async function* () {
                        yield Buffer.from('{"changed":true,"version":1}');
                    })(),
                    headers: {},
                    status: 200,
                },
                transport: "iroh" as const,
            };
        });
        const store = new P2pCredentialStore({
            database: {
                query: <T>() => [] as T,
                transaction: <T>() => false as T,
            },
            identity: local,
        });
        const snapshot = {
            owner: { instanceId: local.instanceId, publicKey: local.publicKey },
            providers: [
                {
                    config: { enabled: true, type: "codex" as const },
                    material: { apiKey: "secret", type: "codex" as const },
                    providerId: "codex",
                    visibility: "owner_only" as const,
                },
            ],
            version: 1,
        };
        const replicator = new P2pCredentialReplicator({
            listPeers: () => [{ instanceId: remote.instanceId, publicKey: remote.publicKey }],
            network: { fetch } as unknown as P2pNetwork,
            snapshot: () => snapshot,
            store,
        });

        await replicator.ensure(remote.instanceId);
        await replicator.ensure(remote.instanceId);
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(requests[0]).toMatchObject({
            method: "PUT",
            path: "/inference-credentials",
        });

        replicator.peerChanged(remote.instanceId);
        await replicator.ensure(remote.instanceId);
        expect(fetch).toHaveBeenCalledTimes(2);
        await replicator.close();
    });

    it("fast-forwards after an owner database reset without accepting the stale version", async () => {
        const owner = createP2pInstanceIdentity(
            "alocalinstance00000000001",
            new Uint8Array(32).fill(1),
        );
        const receiver = createP2pInstanceIdentity(
            "aremoteinstance0000000001",
            new Uint8Array(32).fill(2),
        );
        const ownerDatabase = await PersistentSessionStore.open({ databasePath: ":memory:" });
        const receiverDatabase = await PersistentSessionStore.open({ databasePath: ":memory:" });
        const ownerStore = new P2pCredentialStore({ database: ownerDatabase, identity: owner });
        const receiverStore = new P2pCredentialStore({
            database: receiverDatabase,
            identity: receiver,
        });
        const oldSnapshot = snapshot(owner, "revoked-key", 7);
        await receiverStore.replace(owner.instanceId, oldSnapshot);
        const sentVersions: number[] = [];
        const fetch = vi.fn(async (_peerId: string, request: unknown) => {
            const envelope = JSON.parse(
                Buffer.from((request as { body: Uint8Array }).body).toString("utf8"),
            );
            const decoded = JSON.parse(
                new TextDecoder().decode(
                    receiver.decryptFrom(
                        { ciphertext: envelope.ciphertext, nonce: envelope.nonce },
                        owner.publicKey,
                    ),
                ),
            ) as { version: number };
            sentVersions.push(decoded.version);
            try {
                const result = await receiverStore.replaceEncrypted(
                    owner.instanceId,
                    owner.publicKey,
                    envelope,
                );
                return response(200, result);
            } catch (error) {
                if (error instanceof P2pCredentialVersionConflictError) {
                    return response(409, {
                        error: error.message,
                        version: error.currentVersion,
                    });
                }
                throw error;
            }
        });
        const resetSnapshot = snapshot(owner, "current-key", 1);
        const replicator = new P2pCredentialReplicator({
            listPeers: () => [{ instanceId: receiver.instanceId, publicKey: receiver.publicKey }],
            network: { fetch } as unknown as P2pNetwork,
            snapshot: () => ownerStore.prepareOwnSnapshot(resetSnapshot),
            store: ownerStore,
        });

        try {
            await replicator.ensure(receiver.instanceId);

            expect(sentVersions).toEqual([1, 8]);
            expect((await ownerStore.prepareOwnSnapshot(resetSnapshot)).version).toBe(8);
            expect(await receiverStore.list(owner.instanceId)).toMatchObject([
                { material: { apiKey: "current-key" } },
            ]);
            await expect(receiverStore.replace(owner.instanceId, oldSnapshot)).rejects.toThrow(
                "older than saved state",
            );
        } finally {
            await replicator.close();
            await ownerDatabase.close();
            await receiverDatabase.close();
        }
    });
});

function snapshot(
    owner: ReturnType<typeof createP2pInstanceIdentity>,
    apiKey: string,
    version: number,
) {
    return {
        owner: { instanceId: owner.instanceId, publicKey: owner.publicKey },
        providers: [
            {
                config: { enabled: true, type: "codex" as const },
                material: { apiKey, type: "codex" as const },
                providerId: "codex",
                visibility: "owner_only" as const,
            },
        ],
        version,
    };
}

function response(status: number, body: unknown) {
    return {
        response: {
            body: (async function* () {
                yield Buffer.from(JSON.stringify(body));
            })(),
            headers: {},
            status,
        },
        transport: "iroh" as const,
    };
}
