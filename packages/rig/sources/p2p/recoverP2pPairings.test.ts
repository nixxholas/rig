import { afterEach, describe, expect, it, vi } from "vitest";

import { migrateSessionDatabase } from "../persistence/database/migrateSessionDatabase.js";
import {
    openSessionDatabase,
    type OpenSessionDatabase,
} from "../persistence/database/openSessionDatabase.js";
import { createP2pInstanceIdentity } from "./P2pIdentity.js";
import { P2pPeerTrustStore } from "./P2pPeerTrustStore.js";
import { recoverP2pPairings } from "./recoverP2pPairings.js";

const databases: OpenSessionDatabase[] = [];

afterEach(async () => {
    for (const opened of databases.splice(0)) await opened.client.close();
});

describe("recoverP2pPairings", () => {
    it("activates confirmed trust before assigning primary authority", async () => {
        const store = await createStore();
        const identity = createP2pInstanceIdentity();
        const pending = await prepareReady(store, identity, true);
        const setPrimaryIfUnset = vi.fn(async () => {
            expect(await store.peers()).toEqual([
                expect.objectContaining({ instanceId: identity.instanceId }),
            ]);
        });

        await expect(recoverP2pPairings(store, setPrimaryIfUnset)).resolves.toEqual([
            expect.objectContaining({ instanceId: identity.instanceId }),
        ]);

        expect(setPrimaryIfUnset).toHaveBeenCalledWith(identity.instanceId);
        expect(await store.readyPairings()).toEqual([]);
        expect(await store.peers()).toHaveLength(1);
        await expect(pending.activate()).resolves.toMatchObject({
            instanceId: identity.instanceId,
        });
    });

    it("leaves confirmed trust recoverable when primary persistence fails", async () => {
        const store = await createStore();
        const identity = createP2pInstanceIdentity();
        await prepareReady(store, identity, true);

        await expect(
            recoverP2pPairings(store, async () => {
                throw new Error("runtime.toml is unavailable");
            }),
        ).rejects.toThrow("could not finish every confirmed");

        expect(await store.peers()).toHaveLength(1);
        expect(await store.readyPairings()).toHaveLength(1);

        await recoverP2pPairings(store, async () => undefined);
        expect(await store.peers()).toHaveLength(1);
        expect(await store.readyPairings()).toEqual([]);
    });

    it("never persists primary authority when trust activation fails", async () => {
        const store = await createStore();
        const identity = createP2pInstanceIdentity();
        await prepareReady(store, identity, true);
        const squatter = createP2pInstanceIdentity();
        await store.verifyOrPin(squatter, "iroh", "a".repeat(64), undefined, "Squatter Rig");
        const setPrimaryIfUnset = vi.fn(async () => undefined);

        await expect(recoverP2pPairings(store, setPrimaryIfUnset)).rejects.toThrow(
            "could not finish every confirmed",
        );

        expect(setPrimaryIfUnset).not.toHaveBeenCalled();
        expect(await store.peers()).toHaveLength(1);
        expect((await store.peers())[0]?.instanceId).toBe(squatter.instanceId);
        expect(await store.readyPairings()).toHaveLength(1);
    });

    it("does not recover a transaction that only became locally ready", async () => {
        const store = await createStore();
        const identity = createP2pInstanceIdentity();
        const pending = await store.preparePairing(
            "A".repeat(43),
            identity,
            "iroh",
            "a".repeat(64),
            { iroh: { endpointId: "a".repeat(64) } },
            "Remote",
            true,
            Date.now() + 60_000,
        );
        await pending.markLocallyReady();
        const setPrimaryIfUnset = vi.fn(async () => undefined);

        await expect(recoverP2pPairings(store, setPrimaryIfUnset)).resolves.toEqual([]);

        expect(setPrimaryIfUnset).not.toHaveBeenCalled();
        expect(await store.peers()).toEqual([]);
        expect(await store.readyPairings()).toEqual([]);
    });
});

async function createStore(): Promise<P2pPeerTrustStore> {
    const opened = await openSessionDatabase(":memory:");
    await migrateSessionDatabase(opened.database);
    databases.push(opened);
    return P2pPeerTrustStore.fromDatabase(opened.database);
}

async function prepareReady(
    store: P2pPeerTrustStore,
    identity: ReturnType<typeof createP2pInstanceIdentity>,
    assignPrimary: boolean,
) {
    const pending = await store.preparePairing(
        "A".repeat(43),
        identity,
        "iroh",
        "a".repeat(64),
        { iroh: { endpointId: "a".repeat(64) } },
        "Remote",
        assignPrimary,
        Date.now() + 60_000,
    );
    await pending.markLocallyReady();
    await pending.markConfirmed();
    return pending;
}
