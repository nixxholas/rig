import {
    MemoryMurmurStore,
    MurmurClient,
    destroyIdentity,
    generateIdentityKeyPair,
    type MurmurStore,
    type RelayTransport,
} from "@slopus/murmur";
import { describe, expect, it, vi } from "vitest";

import { DatabaseFailureObservingMurmurStore } from "../impl/DatabaseFailureObservingMurmurStore.js";

describe("DatabaseFailureObservingMurmurStore", () => {
    it("preserves a cursor database failure hidden by Murmur synchronization", async () => {
        const memory = new MemoryMurmurStore();
        const databaseError = Object.assign(new Error("Murmur cursor read failed"), {
            code: "SQLITE_IOERR",
        });
        const store: MurmurStore = {
            delete: (key) => memory.delete(key),
            get: (key) =>
                key.includes("/cursor/") ? Promise.reject(databaseError) : memory.get(key),
            list: (prefix) => memory.list(prefix),
            set: (key, value) => memory.set(key, value),
            transaction: (operation) => memory.transaction(operation),
        };
        const observedStore = new DatabaseFailureObservingMurmurStore(store);
        const readEvents = vi.fn<RelayTransport["readEvents"]>(async () => undefined);
        const transport: RelayTransport = {
            getBlob: async () => undefined,
            id: "test-relay",
            publish: async () => ({ duplicate: false, seq: 1n }),
            putBlob: async () => undefined,
            readEvents,
            readList: async () => undefined,
            readState: async () => undefined,
        };
        const identity = generateIdentityKeyPair();
        try {
            const client = new MurmurClient({
                identity,
                store: observedStore,
                transports: [transport],
            });
            await client.subscribe("test-topic");

            await expect(client.sync()).rejects.toThrow(
                "Every transport failed while reading events",
            );
            expect(readEvents).not.toHaveBeenCalled();
            expect(observedStore.takeDatabaseFailure()).toBe(databaseError);
            expect(observedStore.takeDatabaseFailure()).toBeUndefined();
        } finally {
            destroyIdentity(identity);
        }
    });
});
