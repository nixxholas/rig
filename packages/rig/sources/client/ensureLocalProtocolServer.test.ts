import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { HealthResponse, ReadyHealthResponse } from "../protocol/index.js";
import { ProtocolHttpClient } from "./ProtocolHttpClient.js";
import {
    readOrCreateLocalServerToken,
    superviseSpawnedLocalServer,
    waitForReady,
} from "./ensureLocalProtocolServer.js";

describe("local daemon token", () => {
    it("survives a daemon replacement so attached clients can reconnect", async () => {
        const directory = await mkdtemp(join(tmpdir(), "rig-daemon-token-"));
        const tokenPath = join(directory, "token");
        try {
            const attachedClientToken = await readOrCreateLocalServerToken(tokenPath);

            const replacementDaemonToken = await readOrCreateLocalServerToken(tokenPath);

            expect(replacementDaemonToken).toBe(attachedClientToken);
        } finally {
            await rm(directory, { force: true, recursive: true });
        }
    });

    it("replaces an empty token instead of starting a daemon nobody can authenticate to", async () => {
        const directory = await mkdtemp(join(tmpdir(), "rig-daemon-empty-token-"));
        const tokenPath = join(directory, "token");
        try {
            await writeFile(tokenPath, "\n");

            const token = await readOrCreateLocalServerToken(tokenPath);

            expect(token).not.toBe("");
            expect((await readFile(tokenPath, "utf8")).trim()).toBe(token);
        } finally {
            await rm(directory, { force: true, recursive: true });
        }
    });

    it("repairs an existing token's permissions without rotating it", async () => {
        const directory = await mkdtemp(join(tmpdir(), "rig-daemon-token-mode-"));
        const tokenPath = join(directory, "token");
        try {
            await writeFile(tokenPath, "existing-token\n");
            await chmod(tokenPath, 0o644);

            expect(await readOrCreateLocalServerToken(tokenPath)).toBe("existing-token");
            expect((await stat(tokenPath)).mode & 0o777).toBe(0o600);
        } finally {
            await rm(directory, { force: true, recursive: true });
        }
    });
});

describe("waitForReady", () => {
    afterEach(() => vi.useRealTimers());

    it("recovers from one stalled health poll after observing startup", async () => {
        vi.useFakeTimers();
        const identity = { version: "test" };
        const starting: HealthResponse = {
            healthy: true,
            identity,
            protocolVersion: 1,
            ready: false,
            status: "starting",
        };
        const ready: ReadyHealthResponse = {
            catalog: {
                defaultModelId: "test-model",
                defaultProviderId: "test-provider",
                models: [],
                providers: [],
            },
            durableGlobalEventQueue: false,
            healthy: true,
            identity,
            protocolVersion: 1,
            ready: true,
            status: "ready",
        };
        const health = vi
            .fn<ProtocolHttpClient["health"]>()
            .mockResolvedValueOnce(starting)
            .mockImplementationOnce(
                () =>
                    new Promise((_, reject) => {
                        setTimeout(() => reject(new Error("Health poll stalled.")), 6_000);
                    }),
            )
            .mockResolvedValue(ready);
        const client = { health } as unknown as ProtocolHttpClient;

        const result = expect(waitForReady(client)).resolves.toBe(ready);
        await vi.advanceTimersByTimeAsync(7_000);

        await result;
        expect(health).toHaveBeenCalledTimes(3);
    });
});

describe("spawned daemon supervision", () => {
    afterEach(() => vi.useRealTimers());

    it("terminates and reaps a child whose startup misses the deadline", async () => {
        vi.useFakeTimers();
        const child = new FakeSpawnedDaemon();
        const neverReady = new Promise<void>(() => undefined);

        const supervised = superviseSpawnedLocalServer(child, neverReady, 1_000);
        const result = expect(supervised).rejects.toThrow(
            "Timed out while starting the local Rig daemon",
        );
        await vi.advanceTimersByTimeAsync(1_000);

        await result;
        expect(child.kill).toHaveBeenCalledWith("SIGTERM");
        expect(child.unref).not.toHaveBeenCalled();
        expect(child.listenerCount("exit")).toBe(0);
    });

    it("detaches a child only after startup succeeds", async () => {
        const child = new FakeSpawnedDaemon();

        await expect(
            superviseSpawnedLocalServer(child, Promise.resolve("ready"), 1_000),
        ).resolves.toBe("ready");
        expect(child.unref).toHaveBeenCalledTimes(1);
        expect(child.kill).not.toHaveBeenCalled();
    });
});

class FakeSpawnedDaemon extends EventEmitter {
    exitCode: number | null = null;
    signalCode: NodeJS.Signals | null = null;
    readonly unref = vi.fn();
    readonly kill = vi.fn((signal: NodeJS.Signals) => {
        this.signalCode = signal;
        this.emit("exit", null, signal);
        return true;
    });
}
