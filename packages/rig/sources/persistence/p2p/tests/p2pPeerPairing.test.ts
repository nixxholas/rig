import { afterEach, describe, expect, it } from "vitest";

import { migrateSessionDatabase } from "../../database/migrateSessionDatabase.js";
import {
    openSessionDatabase,
    type OpenSessionDatabase,
} from "../../database/openSessionDatabase.js";
import { createP2pInstanceIdentity } from "../../../p2p/P2pIdentity.js";
import {
    confirmP2pPeerPairing,
    createP2pPeerPairing,
    markP2pPeerPairingLocallyReady,
    queryP2pPeerPairings,
} from "../p2pPeerPairing.js";

const openedDatabases: OpenSessionDatabase[] = [];

afterEach(async () => {
    for (const opened of openedDatabases.splice(0)) await opened.database.close();
});

describe("P2P peer pairing persistence", () => {
    it("persists and advances one pairing through its durable states", async () => {
        const opened = await openSessionDatabase(":memory:");
        await migrateSessionDatabase(opened.database);
        openedDatabases.push(opened);

        const identity = createP2pInstanceIdentity();
        const pairing = {
            assignPrimary: true,
            expiresAt: 100,
            pairingId: "A".repeat(43),
            peer: {
                bindings: [{ address: "a".repeat(64), transport: "iroh" as const }],
                connections: { iroh: { endpointId: "a".repeat(64) } },
                instanceId: identity.instanceId,
                name: "Remote Rig",
                publicKey: identity.publicKey,
            },
            state: "prepared" as const,
        };

        await createP2pPeerPairing(opened.database, pairing);
        expect(await queryP2pPeerPairings(opened.database)).toEqual([pairing]);
        expect(await markP2pPeerPairingLocallyReady(opened.database, pairing.pairingId)).toBe(
            "updated",
        );
        expect(await confirmP2pPeerPairing(opened.database, pairing.pairingId)).toBe("updated");
        expect(await queryP2pPeerPairings(opened.database)).toMatchObject([
            { pairingId: pairing.pairingId, state: "confirmed" },
        ]);
    });
});
