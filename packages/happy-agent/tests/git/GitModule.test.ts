import { afterEach, describe, expect, it } from "vitest";

import { GitModule } from "../../sources/modules/git/GitModule.js";
import type { GitCommandRunner } from "../../sources/modules/git/GitCommandRunner.js";
import { cleanupRoots, commitFile, createRepository, gitRunner, setOriginMain } from "./helpers.js";

afterEach(cleanupRoots);

describe("GitModule", () => {
    it("uses its configured runner for every snapshot command", async () => {
        const repository = await createRepository();
        const head = await commitFile(repository, "tracked.txt", "one\n");
        await setOriginMain(repository, head);
        const calls: string[][] = [];
        const runner: GitCommandRunner = {
            async run(cwd, args, options) {
                calls.push([...args]);
                return await gitRunner.run(cwd, args, options);
            },
        };
        const module = new GitModule({ runner });

        await expect(module.snapshot(repository)).resolves.toMatchObject({
            comparison: "ready",
        });
        expect(calls.some((args) => args[0] === "status")).toBe(true);
        expect(calls.some((args) => args[0] === "diff")).toBe(true);
        expect(calls.some((args) => args[0] === "cat-file")).toBe(false);
    });

    it("cannot fall back to the raw scanner when its runner fails", async () => {
        const repository = await createRepository();
        const head = await commitFile(repository, "tracked.txt", "one\n");
        await setOriginMain(repository, head);
        const runner: GitCommandRunner = {
            async run() {
                return { code: 91, stderr: "configured runner refused", stdout: "" };
            },
        };
        const module = new GitModule({ runner });

        await expect(module.snapshot(repository)).resolves.toMatchObject({
            comparison: "unavailable",
            error: "configured runner refused",
        });
    });

    it("prefers the configured unattended read boundary over foreground Git", async () => {
        const repository = await createRepository();
        const head = await commitFile(repository, "tracked.txt", "one\n");
        await setOriginMain(repository, head);
        let foregroundCalls = 0;
        const runner: GitCommandRunner = {
            async run(cwd, args, options) {
                foregroundCalls += 1;
                return await gitRunner.run(cwd, args, options);
            },
            async scan() {
                throw new Error("read-only boundary refused");
            },
        };
        const module = new GitModule({ runner });

        await expect(module.snapshot(repository)).resolves.toMatchObject({
            comparison: "unavailable",
            error: "read-only boundary refused",
        });
        expect(foregroundCalls).toBe(0);
    });

    it("bounds the cache and clears it on dispose", async () => {
        const repository = await createRepository();
        const head = await commitFile(repository, "tracked.txt", "one\n");
        await setOriginMain(repository, head);
        let statusCalls = 0;
        const runner: GitCommandRunner = {
            async run(cwd, args, options) {
                if (args[0] === "status") statusCalls += 1;
                return await gitRunner.run(cwd, args, options);
            },
        };
        const module = new GitModule({ cacheMs: 60_000, maxCacheEntries: 2, runner });

        await module.snapshot(repository, "one");
        const afterOne = statusCalls;
        await module.snapshot(repository, "two");
        await module.snapshot(repository, "three");
        const afterThree = statusCalls;
        await module.snapshot(repository, "one");
        expect(statusCalls).toBeGreaterThan(afterThree);

        const beforeDispose = statusCalls;
        module.dispose();
        await module.snapshot(repository, "one");
        expect(statusCalls).toBeGreaterThan(beforeDispose);
        expect(afterOne).toBeGreaterThan(0);
    });
});
