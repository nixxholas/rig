import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MurmurClient } from "@slopus/murmur";
import { describe, expect, it } from "vitest";

import { SqliteMurmurStore } from "./SqliteMurmurStore.js";

describe("SqliteMurmurStore", () => {
    it("persists byte values, scans in order, and rolls transactions back", async () => {
        const directory = await mkdtemp(join(tmpdir(), "rig-murmur-store-"));
        const path = join(directory, "sharing.sqlite");
        let store = new SqliteMurmurStore(path);
        try {
            await store.set("murmur/test/b", new Uint8Array([2]));
            await store.set("murmur/test/a", new Uint8Array([1]));
            const page = await store.scan("murmur/test/", { limit: 10 });
            expect([...page.keys()]).toEqual(["murmur/test/a", "murmur/test/b"]);

            await expect(
                store.transaction(async (transaction) => {
                    await transaction.set("murmur/test/c", new Uint8Array([3]));
                    throw new Error("rollback");
                }),
            ).rejects.toThrow("rollback");
            expect(await store.get("murmur/test/c")).toBeUndefined();

            await store.close();
            store = new SqliteMurmurStore(path);
            expect(await store.get("murmur/test/a")).toEqual(new Uint8Array([1]));
            expect((await readFile(path)).length).toBeGreaterThan(0);
        } finally {
            await store.close();
            await rm(directory, { force: true, recursive: true });
        }
    });

    it("persists an identity created by the real Murmur client", async () => {
        const directory = await mkdtemp(join(tmpdir(), "rig-murmur-identity-"));
        const path = join(directory, "sharing.sqlite");
        let store = new SqliteMurmurStore(path);
        try {
            let client = await MurmurClient.open({
                relay: "https://relay.invalid",
                store,
            });
            const identity = client.identity.slice();
            client.close();
            await store.close();

            store = new SqliteMurmurStore(path);
            client = await MurmurClient.open({
                relay: "https://relay.invalid",
                store,
            });
            expect(client.identity).toEqual(identity);
            client.close();
        } finally {
            await store.close();
            await rm(directory, { force: true, recursive: true });
        }
    });
});
