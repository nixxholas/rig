import { createTestRootContext } from "../../testing/createTestRootContext.js";

import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, readdir, readlink, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { MurmurClient } from "@slopus/murmur";
import type { Span, Tracer } from "@opentelemetry/api";
import { beforeEach, describe, expect, it } from "vitest";

import { SqliteMurmurStore } from "./SqliteMurmurStore.js";

describe("SqliteMurmurStore", () => {
    beforeEach(() => {
        createTestRootContext();
    });

    it("persists byte values, scans in order, and rolls transactions back", async () => {
        const directory = await mkdtemp(join(tmpdir(), "rig-murmur-store-"));
        const path = join(directory, "sharing.sqlite");
        let store = new SqliteMurmurStore(path);
        try {
            await store.set("murmur/test/b", new Uint8Array([2]));
            await store.set("murmur/test/a", new Uint8Array([1]));
            const page = await store.scan("murmur/test/", { limit: 10 });
            expect([...page.keys()]).toEqual(["murmur/test/a", "murmur/test/b"]);

            const failure = new Error("rollback");
            await expect(
                store.transaction(async (transaction) => {
                    await transaction.set("murmur/test/c", new Uint8Array([3]));
                    throw failure;
                }),
            ).rejects.toBe(failure);
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

    it("retains the in-memory schema and values after a transaction rotates connections", async () => {
        const store = new SqliteMurmurStore(":memory:");
        try {
            await store.transaction(async (transaction) => {
                await transaction.set("murmur/test/memory", new Uint8Array([7, 8]));
            });

            expect(await store.get("murmur/test/memory")).toEqual(new Uint8Array([7, 8]));
        } finally {
            await store.close();
        }
    });

    it("does not create a root trace for each raw scan", async () => {
        const spans: string[] = [];
        const tracer = {
            startSpan(name: string) {
                spans.push(name);
                return {
                    end() {},
                    isRecording: () => true,
                    recordException() {},
                    setAttribute() {
                        return this;
                    },
                    setAttributes() {
                        return this;
                    },
                    setStatus() {
                        return this;
                    },
                    spanContext: () => ({
                        spanId: "1".repeat(16),
                        traceFlags: 1,
                        traceId: "1".repeat(32),
                    }),
                    updateName() {
                        return this;
                    },
                } as unknown as Span;
            },
        } as unknown as Tracer;
        createTestRootContext(tracer);
        const store = new SqliteMurmurStore(":memory:");
        try {
            await store.set("murmur/test/a", new Uint8Array([1]));
            const rootsAfterInitialization = spans.filter((name) =>
                name.startsWith("rig.worker.murmur-store-"),
            ).length;

            for (let index = 0; index < 25; index += 1) {
                await store.scan("murmur/test/", { limit: 10 });
            }

            expect(spans.filter((name) => name.startsWith("rig.worker.murmur-store-")).length).toBe(
                rootsAfterInitialization,
            );
        } finally {
            await store.close();
        }
    });

    it("drains admitted operations and rejects calls after close begins", async () => {
        const directory = await mkdtemp(join(tmpdir(), "rig-murmur-close-"));
        const path = join(directory, "sharing.sqlite");
        const store = new SqliteMurmurStore(path);
        let markStarted!: () => void;
        let release!: () => void;
        const started = new Promise<void>((resolve) => {
            markStarted = resolve;
        });
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });

        try {
            const admitted = store.transaction(async (transaction) => {
                markStarted();
                await gate;
                await transaction.set("murmur/test/admitted", new Uint8Array([1]));
            });
            await started;

            const queued = store.set("murmur/test/queued", new Uint8Array([2]));
            const closing = store.close();
            let lateSettled = false;
            let lateError: unknown;
            store.set("murmur/test/late", new Uint8Array([3])).then(
                () => {
                    lateSettled = true;
                },
                (error) => {
                    lateSettled = true;
                    lateError = error;
                },
            );
            await Promise.resolve();
            expect(lateSettled).toBe(true);
            expect(lateError).toMatchObject({ message: "Murmur store is closed" });

            release();
            await Promise.all([admitted, queued, closing]);
            await expect(store.get("murmur/test/after-close")).rejects.toThrow(
                "Murmur store is closed",
            );

            const reopened = new SqliteMurmurStore(path);
            try {
                expect(await reopened.get("murmur/test/admitted")).toEqual(new Uint8Array([1]));
                expect(await reopened.get("murmur/test/queued")).toEqual(new Uint8Array([2]));
                expect(await reopened.get("murmur/test/late")).toBeUndefined();
            } finally {
                await reopened.close();
            }
        } finally {
            release();
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

    it("does not retain SQLite file descriptors across repeated transactions", async () => {
        const directory = await mkdtemp(join(tmpdir(), "rig-murmur-fds-"));
        const path = join(directory, "sharing.sqlite");
        const store = new SqliteMurmurStore(path);
        const retainedTransactions: unknown[] = [];
        let baselineDescriptors = Number.MAX_SAFE_INTEGER;
        try {
            await store.set("murmur/test/value", new Uint8Array([0]));
            baselineDescriptors = await countFileDescriptors(path);

            for (let index = 0; index < 40; index += 1) {
                await store.transaction(async (transaction) => {
                    // A caller may retain its facade after the callback. A stale
                    // facade must not retain a detached native connection with it.
                    retainedTransactions.push(transaction);
                    await transaction.set("murmur/test/value", new Uint8Array([index % 256]));
                });
            }

            expect(await countFileDescriptors(path)).toBeLessThanOrEqual(baselineDescriptors + 2);
        } finally {
            await store.close();
            expect(await countFileDescriptors(path)).toBeLessThanOrEqual(baselineDescriptors + 2);
            retainedTransactions.length = 0;
            await rm(directory, { force: true, recursive: true });
        }
    });

    it("rejects a transaction facade after its callback ends", async () => {
        const store = new SqliteMurmurStore(":memory:");
        let escaped: Parameters<Parameters<typeof store.transaction>[0]>[0] | undefined;
        try {
            await store.transaction(async (transaction) => {
                escaped = transaction;
                await transaction.set("murmur/test/committed", new Uint8Array([1]));
            });

            await expect(escaped?.set("murmur/test/escaped", new Uint8Array([2]))).rejects.toThrow(
                "Murmur transaction is closed",
            );
            expect(await store.get("murmur/test/escaped")).toBeUndefined();
        } finally {
            await store.close();
        }
    });
});

async function countFileDescriptors(path: string): Promise<number> {
    const resolvedPath = await realpath(path);
    if (!(await exists("/proc/self/fd"))) {
        const { stdout } = await promisify(execFile)("lsof", [
            "-a",
            "-d",
            "0-999999",
            "-Fn",
            "-p",
            String(process.pid),
        ]);
        return stdout.split("\n").filter((line) => line.startsWith(`n${resolvedPath}`)).length;
    }
    const descriptors = await readdir("/proc/self/fd");
    const targets = await Promise.all(
        descriptors.map(async (descriptor) => {
            try {
                return await readlink(`/proc/self/fd/${descriptor}`);
            } catch {
                return undefined;
            }
        }),
    );
    return targets.filter((target) => target?.startsWith(resolvedPath)).length;
}

async function exists(path: string): Promise<boolean> {
    return access(path).then(
        () => true,
        () => false,
    );
}
