import { afterEach, describe, expect, it } from "vitest";

import { migrateSessionDatabase } from "../../database/migrateSessionDatabase.js";
import {
    openSessionDatabase,
    type OpenSessionDatabase,
} from "../../database/openSessionDatabase.js";
import { createP2pInstanceIdentity } from "../../../p2p/P2pIdentity.js";
import {
    fastForwardP2pCredentialSnapshotVersion,
    prepareP2pCredentialSnapshotVersion,
    queryP2pCredentialSnapshot,
    replaceP2pCredentialSnapshot,
} from "../p2pCredentialSnapshot.js";

const openedDatabases: OpenSessionDatabase[] = [];

afterEach(async () => {
    for (const opened of openedDatabases.splice(0)) await opened.database.close();
});

describe("P2P credential snapshot persistence", () => {
    it("replaces providers and advances the owner's durable version atomically", async () => {
        const opened = await openSessionDatabase(":memory:");
        await migrateSessionDatabase(opened.database);
        openedDatabases.push(opened);

        const owner = createP2pInstanceIdentity();
        const sourceDigest = "a".repeat(64);
        const providers = [
            {
                createdAt: 1,
                encryptedMaterialJson: null,
                ownerInstanceId: owner.instanceId,
                position: 0,
                providerId: "codex",
                publicConfigJson: '{"enabled":true,"type":"codex"}',
                sourceDigest,
                updatedAt: 1,
                visibility: "owner_only" as const,
            },
        ];

        expect(
            await replaceP2pCredentialSnapshot(opened.database, {
                ownerInstanceId: owner.instanceId,
                providers,
                sourceDigest,
                updatedAt: 1,
                version: 1,
            }),
        ).toEqual({ outcome: "changed", version: 1 });
        expect(await queryP2pCredentialSnapshot(opened.database, owner.instanceId)).toEqual({
            ownerInstanceId: owner.instanceId,
            sourceDigest,
            updatedAt: 1,
            version: 1,
        });
        expect(
            await prepareP2pCredentialSnapshotVersion(opened.database, {
                ownerInstanceId: owner.instanceId,
                sourceDigest,
                updatedAt: 2,
            }),
        ).toBe(1);
        expect(
            await fastForwardP2pCredentialSnapshotVersion(opened.database, {
                ownerInstanceId: owner.instanceId,
                receiverVersion: 7,
                snapshotVersion: 1,
                sourceDigest,
                updatedAt: 3,
            }),
        ).toEqual({ outcome: "advanced", version: 8 });
    });
});
