import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createTestSocketDirectory } from "../testing/createTestSocketDirectory.js";
import { createP2pInstanceIdentity } from "./P2pIdentity.js";
import { P2pPeerTrustStore } from "./P2pPeerTrustStore.js";

const directories: string[] = [];

afterEach(async () => {
    const { rm } = await import("node:fs/promises");
    for (const directory of directories.splice(0)) {
        await rm(directory, { force: true, recursive: true });
    }
});

describe("P2pPeerTrustStore", () => {
    it("pins a first authenticated binding and restores it after restart", async () => {
        const path = await trustPath();
        const identity = createP2pInstanceIdentity();
        const store = await P2pPeerTrustStore.open(path);

        await store.validate(identity, "iroh", "a".repeat(64));
        expect(store.peerForBinding("iroh", "a".repeat(64))).toBeUndefined();
        await store.verifyOrPin(identity, "iroh", "a".repeat(64));
        const restored = await P2pPeerTrustStore.open(path);

        expect(restored.peerForBinding("iroh", "a".repeat(64))).toEqual({
            instanceId: identity.instanceId,
            publicKey: identity.publicKey,
        });
    });

    it("lets one stable identity add transport addresses but rejects conflicting pins", async () => {
        const path = await trustPath();
        const trusted = createP2pInstanceIdentity();
        const impostor = createP2pInstanceIdentity(trusted.instanceId);
        const other = createP2pInstanceIdentity();
        const store = await P2pPeerTrustStore.open(path);

        await store.verifyOrPin(trusted, "iroh", "a".repeat(64));
        await store.verifyOrPin(trusted, "iroh", "b".repeat(64));

        await expect(store.verifyOrPin(impostor, "iroh", "c".repeat(64))).rejects.toThrow(
            "does not match",
        );
        await expect(store.verifyOrPin(other, "iroh", "a".repeat(64))).rejects.toThrow(
            "another P2P instance",
        );
        expect(store.peerForBinding("iroh", "b".repeat(64))?.instanceId).toBe(trusted.instanceId);
    });
});

async function trustPath(): Promise<string> {
    const directory = await createTestSocketDirectory();
    directories.push(directory);
    return join(directory, "peers.json");
}
