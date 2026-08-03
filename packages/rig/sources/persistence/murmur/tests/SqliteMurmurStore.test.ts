import { existsSync, mkdtempSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { SqliteMurmurStore } from "../index.js";

function createDatabasePath(): { directory: string; path: string } {
    const directory = mkdtempSync(join(tmpdir(), "rig-murmur-store-"));
    return { directory, path: join(directory, "account.sqlite") };
}

describe("SqliteMurmurStore", () => {
    it("copies values, persists them, and keeps SQLite state private", async () => {
        const { directory, path } = createDatabasePath();
        try {
            const first = new SqliteMurmurStore(path);
            const value = new Uint8Array([1, 2, 3]);
            await first.set("account/key", value);
            value.fill(9);
            const read = await first.get("account/key");
            read?.fill(8);
            expect(await first.get("account/key")).toEqual(new Uint8Array([1, 2, 3]));
            expect(statSync(path).mode & 0o077).toBe(0);
            expect(statSync(`${path}-wal`).mode & 0o077).toBe(0);
            expect(statSync(`${path}-shm`).mode & 0o077).toBe(0);
            await first.close();

            const second = new SqliteMurmurStore(path);
            expect(await second.get("account/key")).toEqual(new Uint8Array([1, 2, 3]));
            await second.close();
        } finally {
            rmSync(directory, { force: true, recursive: true });
        }
    });

    it("rolls back an asynchronous transaction without interleaving another operation", async () => {
        const store = new SqliteMurmurStore(":memory:");
        let allowRollback: () => void = () => {};
        const rollbackStarted = new Promise<void>((resolve) => {
            allowRollback = resolve;
        });
        let continueRollback: () => void = () => {};
        const rollbackMayFinish = new Promise<void>((resolve) => {
            continueRollback = resolve;
        });

        const rollback = store.transaction(async (transaction) => {
            await transaction.set("before", new Uint8Array([2]));
            allowRollback();
            await rollbackMayFinish;
            throw new Error("rollback");
        });
        await rollbackStarted;
        const after = store.set("after", new Uint8Array([3]));
        continueRollback();

        await expect(rollback).rejects.toThrow("rollback");
        await after;
        expect(await store.get("before")).toBeUndefined();
        expect(await store.get("after")).toEqual(new Uint8Array([3]));
        await store.close();
    });

    it("reads one ordered bounded page without loading the rest of a prefix", async () => {
        const store = new SqliteMurmurStore(":memory:");
        await store.set("outbox/a", new Uint8Array([1]));
        await store.set("outbox/b", new Uint8Array([2]));
        await store.set("outbox/c", new Uint8Array([3]));
        await store.set("other/a", new Uint8Array([4]));

        await expect(store.listPage("outbox/", undefined, 2)).resolves.toEqual(
            new Map([
                ["outbox/a", new Uint8Array([1])],
                ["outbox/b", new Uint8Array([2])],
            ]),
        );
        await expect(store.listPage("outbox/", "outbox/b", 2)).resolves.toEqual(
            new Map([["outbox/c", new Uint8Array([3])]]),
        );
        await store.close();
    });

    it("rejects symlinked state and removes every state file only after close", async () => {
        const { directory, path } = createDatabasePath();
        const target = join(directory, "target.sqlite");
        const linked = join(directory, "linked.sqlite");
        try {
            const targetStore = new SqliteMurmurStore(target);
            symlinkSync(target, linked);
            expect(() => new SqliteMurmurStore(linked)).toThrow(
                "Murmur SQLite state must use regular private files",
            );
            await targetStore.close();

            const store = new SqliteMurmurStore(path);
            await store.set("key", new Uint8Array([1]));
            await expect(store.deleteDatabaseFiles()).rejects.toThrow(
                "Close the Murmur SQLite store before deleting its database files",
            );
            await store.close();
            await store.deleteDatabaseFiles();
            await store.deleteDatabaseFiles();

            expect(existsSync(path)).toBe(false);
            expect(existsSync(`${path}-wal`)).toBe(false);
            expect(existsSync(`${path}-shm`)).toBe(false);
        } finally {
            rmSync(directory, { force: true, recursive: true });
        }
    });
});
