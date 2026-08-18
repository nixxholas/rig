import { MAXIMUM_STORE_SCAN_ITEMS } from "@slopus/murmur";
import { describe, expect, it } from "vitest";

import { murmurMigrations } from "../../sources/murmur/MurmurDatabase.js";
import { SqliteMurmurStore } from "../../sources/murmur/SqliteMurmurStore.js";
import { moduleDatabase } from "../support/moduleDatabase.js";

async function openStore(name: string) {
    const test = moduleDatabase(murmurMigrations, name);
    await test.ready;
    return { store: new SqliteMurmurStore(test.rootContext), test };
}

describe("the Murmur store in the agent database", () => {
    it("keeps what it was given and reads it back", async () => {
        const { store, test } = await openStore("murmur-store-roundtrip");
        try {
            await store.set("contacts/one", Uint8Array.from([1, 2, 3]));
            await store.set("contacts/two", Uint8Array.from([4, 5]));
            await store.set("sessions/one", Uint8Array.from([6]));

            await expect(store.get("contacts/one")).resolves.toEqual(Uint8Array.from([1, 2, 3]));
            await expect(store.get("nothing")).resolves.toBeUndefined();
            // An empty value is a value, not an absence.
            await store.set("contacts/empty", new Uint8Array());
            await expect(store.get("contacts/empty")).resolves.toEqual(new Uint8Array());

            // Overwriting replaces rather than accumulates.
            await store.set("contacts/one", Uint8Array.from([9]));
            await expect(store.get("contacts/one")).resolves.toEqual(Uint8Array.from([9]));

            await store.delete("contacts/two");
            await expect(store.get("contacts/two")).resolves.toBeUndefined();
            // Deleting what is not there is how an interrupted cleanup gets retried.
            await expect(store.delete("contacts/two")).resolves.toBeUndefined();
        } finally {
            await store.close();
            test.close();
        }
    });

    it("pages through a prefix in byte order without repeating or skipping a key", async () => {
        const { store, test } = await openStore("murmur-store-scan");
        try {
            // Base64url keys differ by case and by punctuation, which is exactly what a
            // linguistic collation would fold together and a byte order must keep apart.
            const keys = ["murmur/c/A", "murmur/c/Z", "murmur/c/_a", "murmur/c/a", "murmur/c/z"];
            for (const key of keys) await store.set(key, Uint8Array.from([1]));
            await store.set("murmur/other/A", Uint8Array.from([2]));

            expect([...(await store.list("murmur/c/"))].map(([key]) => key)).toEqual(keys);

            const seen: string[] = [];
            let after: string | undefined;
            for (;;) {
                const page = [
                    ...(await store.scan("murmur/c/", {
                        limit: 2,
                        ...(after === undefined ? {} : { after }),
                    })),
                ].map(([key]) => key);
                if (page.length === 0) break;
                seen.push(...page);
                after = page.at(-1);
            }
            expect(seen).toEqual(keys);
        } finally {
            await store.close();
            test.close();
        }
    });

    it("refuses a scan limit Murmur would never ask for", async () => {
        const { store, test } = await openStore("murmur-store-scan-limit");
        try {
            for (const limit of [0, -1, 1.5, MAXIMUM_STORE_SCAN_ITEMS + 1]) {
                await expect(store.scan("murmur/", { limit })).rejects.toThrow(
                    "Invalid Murmur store scan limit",
                );
            }
        } finally {
            await store.close();
            test.close();
        }
    });

    it("commits a transaction that succeeds and loses one that throws", async () => {
        const { store, test } = await openStore("murmur-store-transaction");
        try {
            await store.set("contacts/one", Uint8Array.from([1]));

            await expect(
                store.transaction(async (transaction) => {
                    await transaction.set("contacts/three", Uint8Array.from([7]));
                    // Murmur reads its own uncommitted writes before deciding to give up.
                    await expect(transaction.get("contacts/three")).resolves.toEqual(
                        Uint8Array.from([7]),
                    );
                    throw new Error("The caller changed its mind.");
                }),
            ).rejects.toThrow("The caller changed its mind.");
            await expect(store.get("contacts/three")).resolves.toBeUndefined();

            const removed = await store.transaction(async (transaction) => {
                await transaction.set("contacts/three", Uint8Array.from([7]));
                await transaction.delete("contacts/one");
                return [...(await transaction.list("contacts/"))].map(([key]) => key);
            });
            expect(removed).toEqual(["contacts/three"]);
            await expect(store.get("contacts/three")).resolves.toEqual(Uint8Array.from([7]));
            await expect(store.get("contacts/one")).resolves.toBeUndefined();
        } finally {
            await store.close();
            test.close();
        }
    });

    it("refuses every operation once it is closed, however often it is closed", async () => {
        const { store, test } = await openStore("murmur-store-closed");
        try {
            await store.set("contacts/one", Uint8Array.from([1]));

            await store.close();
            // Closing twice is what an interrupted shutdown looks like, and it is not a failure.
            await store.close();

            await expect(store.get("contacts/one")).rejects.toThrow("Murmur store is closed");
            await expect(store.set("contacts/two", Uint8Array.from([2]))).rejects.toThrow(
                "Murmur store is closed",
            );
            await expect(store.delete("contacts/one")).rejects.toThrow("Murmur store is closed");
            await expect(store.list("contacts/")).rejects.toThrow("Murmur store is closed");
            await expect(store.transaction(async () => undefined)).rejects.toThrow(
                "Murmur store is closed",
            );

            // The agent database is not the store's to close, so what it held is still there.
            const reopened = new SqliteMurmurStore(test.rootContext);
            await expect(reopened.get("contacts/one")).resolves.toEqual(Uint8Array.from([1]));
            await reopened.close();
        } finally {
            test.close();
        }
    });
});
