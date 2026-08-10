import { createTestRootContext } from "../testing/createTestRootContext.js";

import { afterEach, describe, expect, it } from "vitest";

import { migrateSessionDatabase } from "../persistence/database/migrateSessionDatabase.js";
import { withDatabase } from "../persistence/database/databaseContext.js";
import {
    openSessionDatabase,
    type OpenSessionDatabase,
} from "../persistence/database/openSessionDatabase.js";
import { createP2pInstanceIdentity } from "./P2pIdentity.js";
import { P2pPeerTrustStore } from "./P2pPeerTrustStore.js";

const databases: OpenSessionDatabase[] = [];
const ctx = createTestRootContext();

afterEach(async () => {
    for (const opened of databases.splice(0)) await opened.database.close(opened.ctx);
});

describe("P2pPeerTrustStore", () => {
    it("pins authenticated identity, bindings, and reusable connections in SQLite", async () => {
        const opened = await openTrustDatabase();
        const identity = createP2pInstanceIdentity();
        const store = P2pPeerTrustStore.fromDatabase(opened.database);

        await store.validate(ctx, identity, "iroh", "a".repeat(64));
        expect(await store.peerForBinding(ctx, "iroh", "a".repeat(64))).toBeUndefined();
        await store.verifyOrPin(
            ctx,
            identity,
            "iroh",
            "a".repeat(64),
            {
                iroh: { endpointId: "a".repeat(64) },
            },
            "Remote Rig",
        );
        const restored = P2pPeerTrustStore.fromDatabase(opened.database);

        expect(await restored.peerForBinding(ctx, "iroh", "a".repeat(64))).toEqual({
            instanceId: identity.instanceId,
            publicKey: identity.publicKey,
        });
        expect((await restored.peers(ctx))[0]?.connections.iroh?.endpointId).toBe("a".repeat(64));
    });

    it("refreshes an Iroh address ticket without changing the trusted identity", async () => {
        const opened = await openTrustDatabase();
        const identity = createP2pInstanceIdentity();
        const store = P2pPeerTrustStore.fromDatabase(opened.database);
        const endpointId = "a".repeat(64);

        await store.verifyOrPin(
            ctx,
            identity,
            "iroh",
            endpointId,
            {
                iroh: { endpointId, ticket: "first-ticket" },
            },
            "Remote Rig",
        );
        await store.verifyOrPin(ctx, identity, "iroh", endpointId, {
            iroh: { endpointId, ticket: "second-ticket" },
        });

        expect((await store.peers(ctx))[0]).toMatchObject({
            connections: { iroh: { endpointId, ticket: "second-ticket" } },
            instanceId: identity.instanceId,
            publicKey: identity.publicKey,
        });
    });

    it("lets one stable identity add transport addresses but rejects conflicting pins", async () => {
        const opened = await openTrustDatabase();
        const trusted = createP2pInstanceIdentity();
        const impostor = createP2pInstanceIdentity(trusted.instanceId);
        const other = createP2pInstanceIdentity();
        const store = P2pPeerTrustStore.fromDatabase(opened.database);

        await store.verifyOrPin(ctx, trusted, "iroh", "a".repeat(64), undefined, "Remote Rig");
        await store.verifyOrPin(ctx, trusted, "iroh", "b".repeat(64));

        await expect(store.verifyOrPin(ctx, impostor, "iroh", "c".repeat(64))).rejects.toThrow(
            "does not match",
        );
        await expect(store.verifyOrPin(ctx, other, "iroh", "a".repeat(64))).rejects.toThrow(
            "another P2P instance",
        );
        expect((await store.peerForBinding(ctx, "iroh", "b".repeat(64)))?.instanceId).toBe(
            trusted.instanceId,
        );
    });

    it("refuses to create trusted peer state without a display name", async () => {
        const opened = await openTrustDatabase();
        const identity = createP2pInstanceIdentity();
        const store = P2pPeerTrustStore.fromDatabase(opened.database);

        await expect(store.verifyOrPin(ctx, identity, "iroh", "a".repeat(64))).rejects.toThrow(
            "must have a display name",
        );
        expect(await store.peers(ctx)).toEqual([]);
    });

    it("keeps prepared pairing trust inactive and removes it when pairing aborts", async () => {
        const opened = await openTrustDatabase();
        const identity = createP2pInstanceIdentity();
        const store = P2pPeerTrustStore.fromDatabase(opened.database);

        const prepared = await store.preparePairing(
            ctx,
            "A".repeat(43),
            identity,
            "iroh",
            "a".repeat(64),
            { iroh: { endpointId: "a".repeat(64) } },
            "Remote",
            false,
            Date.now() + 60_000,
        );
        expect(await store.peers(ctx)).toEqual([]);
        expect(await store.readyPairings(ctx)).toEqual([]);

        await prepared.abort(ctx);
        expect(await store.peers(ctx)).toEqual([]);
        expect(await store.readyPairings(ctx)).toEqual([]);
    });

    it("recovers a durable ready pairing and promotes it into active trust", async () => {
        const opened = await openTrustDatabase();
        const identity = createP2pInstanceIdentity();
        const store = P2pPeerTrustStore.fromDatabase(opened.database);
        const prepared = await store.preparePairing(
            ctx,
            "A".repeat(43),
            identity,
            "iroh",
            "a".repeat(64),
            { iroh: { endpointId: "a".repeat(64) } },
            "Remote",
            true,
            Date.now() + 60_000,
        );
        await prepared.markLocallyReady(ctx);
        await prepared.markConfirmed(ctx);

        const restored = P2pPeerTrustStore.fromDatabase(opened.database);
        expect(await restored.peers(ctx)).toEqual([]);
        expect(await restored.readyPairings(ctx)).toHaveLength(1);
        await (await restored.readyPairings(ctx))[0]!.activate(ctx);
        expect(await restored.readyPairings(ctx)).toHaveLength(1);
        await (await restored.readyPairings(ctx))[0]!.complete(ctx);
        expect((await restored.peers(ctx))[0]).toMatchObject({
            instanceId: identity.instanceId,
            name: "Remote",
        });
        expect(await restored.readyPairings(ctx)).toEqual([]);
    });

    it("aborting one transaction cannot erase an identical pairing that finalized", async () => {
        const opened = await openTrustDatabase();
        const identity = createP2pInstanceIdentity();
        const store = P2pPeerTrustStore.fromDatabase(opened.database);
        const first = await store.preparePairing(
            ctx,
            "A".repeat(43),
            identity,
            "iroh",
            "a".repeat(64),
            { iroh: { endpointId: "a".repeat(64) } },
            "Remote",
            false,
            Date.now() + 60_000,
        );
        const second = await store.preparePairing(
            ctx,
            "B".repeat(43),
            identity,
            "iroh",
            "a".repeat(64),
            { iroh: { endpointId: "a".repeat(64) } },
            "Remote",
            false,
            Date.now() + 60_000,
        );

        await second.markLocallyReady(ctx);
        await second.markConfirmed(ctx);
        await second.activate(ctx);
        await second.complete(ctx);
        await first.abort(ctx);

        expect(await store.peers(ctx)).toHaveLength(1);
        expect((await store.peers(ctx))[0]?.instanceId).toBe(identity.instanceId);
    });
});

async function openTrustDatabase(): Promise<OpenSessionDatabase> {
    const opened = await openSessionDatabase(ctx, ":memory:");
    await migrateSessionDatabase(opened.ctx);
    databases.push(opened);
    return opened;
}
