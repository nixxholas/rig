import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { GitStateTracker, type GitChangeSnapshot } from "./GitStateTracker.js";
import { supportsRecursiveWorktreeWatch } from "./watchGitRepositoryChanges.js";
import { resolveGitTrackedEntity } from "./resolveGitTrackedEntity.js";
import type { Project } from "../protocol/index.js";

const execFile = promisify(execFileCallback);
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
    await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("GitStateTracker watching", () => {
    /**
     * The tracker is driven exactly as production drives it: through `resolveGitTrackedEntity`, with
     * the real watcher and no forced refresh. An earlier version passed every other test while
     * arming no watchers at all, because the entity never carried the Git directories the tracker
     * required and every other test either stubbed the watcher or called `?refresh=1`.
     */
    it.runIf(supportsRecursiveWorktreeWatch())(
        "publishes a snapshot from a working-tree edit alone, without a forced refresh",
        async () => {
            const repository = await createRepository();
            const published: GitChangeSnapshot[] = [];
            const tracker = new GitStateTracker({
                onSnapshot: (_entity, snapshot) => published.push(snapshot),
                // A reconciliation poll this slow cannot be what delivers the change.
                tuning: { debounceMs: 20, maximumDebounceMs: 50, reconcileIntervalMs: 600_000 },
            });
            cleanups.push(async () => tracker.dispose());
            const entity = resolveGitTrackedEntity(projectFor(repository));
            if (entity === undefined) throw new Error("Expected a trackable project.");

            tracker.watch(entity);
            await waitFor(() => published.length >= 1);
            const initial = published.length;

            await writeFile(join(repository, "watched.txt"), "one\ntwo\n");

            await waitFor(() => published.length > initial, 15_000);
            const latest = published.at(-1)!;
            expect(latest.changedFiles).toBe(1);
            expect(latest.insertions).toBe(2);
        },
        30_000,
    );

    it("notices a commit made outside Rig", async () => {
        const repository = await createRepository();
        const published: GitChangeSnapshot[] = [];
        const tracker = new GitStateTracker({
            onSnapshot: (_entity, snapshot) => published.push(snapshot),
            tuning: { debounceMs: 20, maximumDebounceMs: 50, reconcileIntervalMs: 600_000 },
        });
        cleanups.push(async () => tracker.dispose());
        const entity = resolveGitTrackedEntity(projectFor(repository));
        if (entity === undefined) throw new Error("Expected a trackable project.");
        tracker.watch(entity);
        await waitFor(() => published.length >= 1);
        await writeFile(join(repository, "committed.txt"), "x\n");
        await waitFor(() => published.some((snapshot) => snapshot.changedFiles === 1), 15_000);
        const beforeCommit = published.length;

        await git(repository, ["add", "--all"]);
        await git(repository, ["commit", "--quiet", "--message", "outside Rig"]);

        await waitFor(() => published.length > beforeCommit, 15_000);
        expect(published.at(-1)?.changedFiles).toBe(0);
    }, 30_000);
});

function projectFor(path: string): Project {
    return {
        createdAt: 1,
        id: "project-1",
        initializationAttempt: 0,
        initializationStatus: "ready",
        kind: "regular",
        name: "Fixture",
        nameSource: "folder",
        orderKey: "a0",
        path,
        presence: "present",
        storageKey: "fixture",
        updatedAt: 1,
        version: 1,
        worktreeSupport: "supported",
    };
}

async function createRepository(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "rig-git-watching-"));
    cleanups.push(async () => rm(root, { force: true, recursive: true }));
    const repository = join(root, "repository");
    await mkdir(repository);
    await git(repository, ["init", "--quiet", "--initial-branch=main"]);
    await git(repository, ["config", "user.email", "test@example.com"]);
    await git(repository, ["config", "user.name", "Test"]);
    await writeFile(join(repository, "seed.txt"), "seed\n");
    await git(repository, ["add", "--all"]);
    await git(repository, ["commit", "--quiet", "--message", "seed"]);
    return repository;
}

async function git(cwd: string, args: readonly string[]): Promise<void> {
    await execFile("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 20_000 });
}

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("Timed out waiting for a published snapshot.");
}
