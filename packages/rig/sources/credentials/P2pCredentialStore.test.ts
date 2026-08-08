import { afterEach, describe, expect, it } from "vitest";

import { createP2pInstanceIdentity, type P2pInstanceIdentity } from "../p2p/P2pIdentity.js";
import { queryP2pProvisionedProviders } from "../persistence/p2p-credential/queryP2pProvisionedProviders.js";
import type { P2pCredentialSnapshot } from "../protocol/P2pCredentialProtocol.js";
import { PersistentSessionStore } from "../session/PersistentSessionStore.js";
import { P2pCredentialStore } from "./P2pCredentialStore.js";

describe("P2pCredentialStore", () => {
    let database: PersistentSessionStore | undefined;

    afterEach(() => database?.close());

    it("keeps same-ID provider snapshots isolated by authenticated owner", () => {
        database = new PersistentSessionStore({ databasePath: ":memory:" });
        const receiver = createP2pInstanceIdentity();
        const firstOwner = createP2pInstanceIdentity();
        const secondOwner = createP2pInstanceIdentity();
        const credentials = new P2pCredentialStore({
            database,
            identity: receiver,
            now: () => 1_000,
        });

        expect(
            credentials.replace(firstOwner.instanceId, snapshot(firstOwner, "first-key")),
        ).toEqual({ changed: true, version: 1 });
        expect(
            credentials.replace(secondOwner.instanceId, snapshot(secondOwner, "second-key")),
        ).toEqual({ changed: true, version: 1 });
        expect(credentials.list(firstOwner.instanceId)).toMatchObject([
            { material: { apiKey: "first-key" }, providerId: "codex" },
        ]);
        expect(credentials.list(secondOwner.instanceId)).toMatchObject([
            { material: { apiKey: "second-key" }, providerId: "codex" },
        ]);

        expect(
            credentials.replace(firstOwner.instanceId, {
                owner: peer(firstOwner),
                providers: [],
                version: 2,
            }),
        ).toEqual({ changed: true, version: 2 });
        expect(credentials.list(firstOwner.instanceId)).toEqual([]);
        expect(credentials.list(secondOwner.instanceId)).toMatchObject([
            { material: { apiKey: "second-key" }, providerId: "codex" },
        ]);
    });

    it("does not rewrite an identical owner snapshot", () => {
        database = new PersistentSessionStore({ databasePath: ":memory:" });
        const receiver = createP2pInstanceIdentity();
        const owner = createP2pInstanceIdentity();
        let now = 1_000;
        const credentials = new P2pCredentialStore({
            database,
            identity: receiver,
            now: () => now,
        });
        const first = snapshot(owner, "same-key");

        expect(credentials.replace(owner.instanceId, first)).toEqual({
            changed: true,
            version: 1,
        });
        const stored = database.query((tx) => queryP2pProvisionedProviders(tx, owner.instanceId));
        now = 2_000;
        expect(credentials.replace(owner.instanceId, first)).toEqual({
            changed: false,
            version: 1,
        });
        expect(database.query((tx) => queryP2pProvisionedProviders(tx, owner.instanceId))).toEqual(
            stored,
        );
    });

    it("rejects stale replays and same-version conflicts after rotation or revocation", () => {
        database = new PersistentSessionStore({ databasePath: ":memory:" });
        const receiver = createP2pInstanceIdentity();
        const owner = createP2pInstanceIdentity();
        const credentials = new P2pCredentialStore({ database, identity: receiver });
        const first = snapshot(owner, "first-key", 1);
        const rotated = snapshot(owner, "rotated-key", 2);

        expect(credentials.replace(owner.instanceId, first)).toEqual({
            changed: true,
            version: 1,
        });
        expect(credentials.replace(owner.instanceId, rotated)).toEqual({
            changed: true,
            version: 2,
        });
        expect(() => credentials.replace(owner.instanceId, first)).toThrow(
            "older than saved state",
        );
        expect(() =>
            credentials.replace(owner.instanceId, snapshot(owner, "conflicting-key", 2)),
        ).toThrow("conflicts with the saved version");

        const revoked: P2pCredentialSnapshot = {
            owner: peer(owner),
            providers: [],
            version: 3,
        };
        expect(credentials.replace(owner.instanceId, revoked)).toEqual({
            changed: true,
            version: 3,
        });
        expect(credentials.list(owner.instanceId)).toEqual([]);
        expect(() => credentials.replace(owner.instanceId, rotated)).toThrow(
            "older than saved state",
        );
    });

    it("assigns stable durable versions to this Rig's outgoing snapshots", () => {
        database = new PersistentSessionStore({ databasePath: ":memory:" });
        const owner = createP2pInstanceIdentity();
        const credentials = new P2pCredentialStore({ database, identity: owner });

        const first = credentials.prepareOwnSnapshot(snapshot(owner, "first-key"));
        expect(first.version).toBe(1);
        expect(credentials.prepareOwnSnapshot(snapshot(owner, "first-key")).version).toBe(1);
        expect(credentials.prepareOwnSnapshot(snapshot(owner, "rotated-key")).version).toBe(2);
        expect(
            credentials.prepareOwnSnapshot({
                owner: peer(owner),
                providers: [],
                version: 1,
            }).version,
        ).toBe(3);
    });

    it("fast-forwards a reset owner's current payload above a receiver version", () => {
        database = new PersistentSessionStore({ databasePath: ":memory:" });
        const owner = createP2pInstanceIdentity();
        const credentials = new P2pCredentialStore({ database, identity: owner });
        const resetSnapshot = credentials.prepareOwnSnapshot(snapshot(owner, "current-key"));

        expect(resetSnapshot.version).toBe(1);
        expect(credentials.fastForwardOwnSnapshot(resetSnapshot, 7)).toMatchObject({
            providers: [{ material: { apiKey: "current-key" } }],
            version: 8,
        });
        expect(credentials.prepareOwnSnapshot(snapshot(owner, "current-key")).version).toBe(8);
        expect(() =>
            credentials.fastForwardOwnSnapshot(snapshot(owner, "stale-local-key"), 9),
        ).toThrow("changed while its version was reconciled");
    });

    it("decrypts an authenticated peer envelope and keeps material encrypted at rest", () => {
        database = new PersistentSessionStore({ databasePath: ":memory:" });
        const receiver = createP2pInstanceIdentity();
        const owner = createP2pInstanceIdentity();
        const receiverStore = new P2pCredentialStore({ database, identity: receiver });
        const senderStore = new P2pCredentialStore({ database, identity: owner });
        const encrypted = senderStore.encryptForPeer(
            snapshot(owner, "secret-key"),
            receiver.publicKey,
        );

        expect(
            receiverStore.replaceEncrypted(owner.instanceId, owner.publicKey, encrypted),
        ).toEqual({ changed: true, version: 1 });
        expect(receiverStore.list(owner.instanceId)).toMatchObject([
            { material: { apiKey: "secret-key" }, providerId: "codex" },
        ]);
        expect(
            database.query((tx) => queryP2pProvisionedProviders(tx, owner.instanceId))[0]
                ?.encryptedMaterialJson,
        ).not.toContain("secret-key");
    });

    it("rejects mismatched owners and invalid credential material", () => {
        database = new PersistentSessionStore({ databasePath: ":memory:" });
        const receiver = createP2pInstanceIdentity();
        const owner = createP2pInstanceIdentity();
        const anotherOwner = createP2pInstanceIdentity();
        const credentials = new P2pCredentialStore({ database, identity: receiver });

        expect(() =>
            credentials.replace(anotherOwner.instanceId, snapshot(owner, "owner-key")),
        ).toThrow("does not match its authenticated owner");
        expect(() =>
            credentials.replace(owner.instanceId, {
                ...snapshot(owner, "owner-key"),
                providers: [
                    {
                        config: { enabled: true, type: "codex" },
                        material: { apiKey: "", type: "codex" },
                        providerId: "codex",
                        visibility: "owner_only",
                    },
                ],
            } as unknown as P2pCredentialSnapshot),
        ).toThrow("snapshot is invalid");

        const senderStore = new P2pCredentialStore({ database, identity: owner });
        const envelope = senderStore.encryptForPeer(
            snapshot(owner, "owner-key"),
            receiver.publicKey,
        );
        expect(() =>
            credentials.replaceEncrypted(anotherOwner.instanceId, owner.publicKey, envelope),
        ).toThrow("not owned by its sender");
    });
});

function snapshot(owner: P2pInstanceIdentity, apiKey: string, version = 1): P2pCredentialSnapshot {
    return {
        owner: peer(owner),
        providers: [
            {
                config: { enabled: true, type: "codex" },
                material: { apiKey, type: "codex" },
                providerId: "codex",
                visibility: "owner_only",
            },
        ],
        version,
    };
}

function peer(identity: P2pInstanceIdentity) {
    return { instanceId: identity.instanceId, publicKey: identity.publicKey };
}
