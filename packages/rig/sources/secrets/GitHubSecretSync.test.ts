import { afterEach, describe, expect, it, vi } from "vitest";

import { SecretRegistry } from "./SecretRegistry.js";
import { GitHubSecretSync, type GitHubCliTokenResult } from "./GitHubSecretSync.js";

afterEach(() => {
    vi.useRealTimers();
});

describe("GitHubSecretSync", () => {
    it("loads immediately, refreshes on schedule, retains transiently unavailable credentials, and removes signed-out credentials", async () => {
        vi.useFakeTimers();
        const results: GitHubCliTokenResult[] = [
            { status: "available", token: "first" },
            { status: "available", token: "rotated" },
            { status: "unavailable" },
            { status: "not_authenticated" },
        ];
        const registry = new SecretRegistry();
        const sync = new GitHubSecretSync({
            readToken: async () => results.shift() ?? { status: "unavailable" },
            refreshIntervalMs: 1_000,
            register: (secret) => registry.register(secret),
            unregister: () => {
                registry.unregisterSpecial("github");
            },
        });

        await sync.refresh();
        expect(registry.resolve(["github"])).toEqual({ GH_TOKEN: "first" });

        const controller = new AbortController();
        const running = sync.run(controller.signal);
        await vi.advanceTimersByTimeAsync(1_000);
        expect(registry.resolve(["github"])).toEqual({ GH_TOKEN: "rotated" });

        await vi.advanceTimersByTimeAsync(1_000);
        expect(registry.resolve(["github"])).toEqual({ GH_TOKEN: "rotated" });

        await vi.advanceTimersByTimeAsync(1_000);
        expect(registry.references()).toEqual([]);

        controller.abort();
        await running;
    });
});
