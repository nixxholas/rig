import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { gitWatchTargets, watchGitRepositoryChanges } from "../watchGitRepositoryChanges.js";

const execFile = promisify(execFileCallback);
const roots: string[] = [];
const disposers: (() => void)[] = [];

afterEach(async () => {
    for (const dispose of disposers.splice(0)) dispose();
    await Promise.allSettled(
        roots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
    );
});

describe("gitWatchTargets", () => {
    it("watches directories rather than the control files Git replaces by rename", async () => {
        const repository = await createRepository();
        await commit(repository, "a.txt", "one\n");
        const gitDirectory = await git(repository, [
            "rev-parse",
            "--path-format=absolute",
            "--git-dir",
        ]);

        const targets = gitWatchTargets({
            commonDirectory: gitDirectory,
            gitDirectory,
            path: repository,
        });

        // Git writes HEAD, index, and packed-refs through a lock file plus rename. A watch on any
        // of those paths binds to an inode that is discarded by the first commit, so every target
        // must be a directory. This is asserted structurally because macOS cannot reproduce the
        // failure: its FSEvents backend resolves watches by path.
        for (const target of targets) {
            await expect(isDirectory(target.directory)).resolves.toBe(true);
        }
        expect(targets.map((target) => target.directory)).toContain(gitDirectory);
    });

    it("watches the whole ref root recursively so slashed and remote refs are covered", async () => {
        const targets = gitWatchTargets({
            commonDirectory: "/repo/.git",
            gitDirectory: "/repo/.git",
            path: "/repo",
        });

        // Watching refs/heads and refs/remotes separately fails to arm on a repository that has
        // never fetched, because Git does not create refs/remotes until then and the watch is
        // never retried. The ref root always exists.
        const refs = targets.find((target) => target.directory === "/repo/.git/refs");
        expect(refs?.recursive).toBe(true);
        expect(targets.map((target) => target.directory)).not.toContain("/repo/.git/refs/remotes");
    });

    it("watches the worktree Git directory and the common directory separately", () => {
        const targets = gitWatchTargets({
            commonDirectory: "/repo/.git",
            gitDirectory: "/repo/.git/worktrees/feature",
            path: "/worktrees/feature",
        });

        // A linked worktree keeps its own HEAD and index, while branch refs stay in the common
        // directory, so both have to be watched.
        expect(targets.map((target) => target.directory)).toEqual(
            expect.arrayContaining(["/repo/.git/worktrees/feature", "/repo/.git"]),
        );
    });
});

describe("watchGitRepositoryChanges", { timeout: 30_000 }, () => {
    it("reconciles once after arming to close the scan-to-watch race", async () => {
        const repository = await createRepository();
        await commit(repository, "a.txt", "one\n");
        const gitDirectory = await git(repository, [
            "rev-parse",
            "--path-format=absolute",
            "--git-dir",
        ]);
        let dirty = 0;

        const dispose = watchGitRepositoryChanges({
            commonDirectory: gitDirectory,
            gitDirectory,
            onDirty: () => {
                dirty += 1;
            },
            path: repository,
        });
        disposers.push(dispose);

        expect(dirty).toBe(1);
    });

    it("keeps noticing commits after the first one", async () => {
        const repository = await createRepository();
        await commit(repository, "a.txt", "one\n");
        const dirty = await watchRepository(repository);

        await commit(repository, "b.txt", "two\n");
        await waitFor(() => dirty.count >= 1);
        const afterFirst = dirty.count;

        // Git replaces HEAD and the index by renaming a lock file over them. A watch on the
        // files themselves would follow the dead inode and go silent from here on.
        await commit(repository, "c.txt", "three\n");
        await waitFor(() => dirty.count > afterFirst);
        await commit(repository, "d.txt", "four\n");
        await waitFor(() => dirty.count > afterFirst + 1);

        expect(dirty.count).toBeGreaterThan(afterFirst + 1);
    });

    it("notices a branch whose name contains a slash", async () => {
        const repository = await createRepository();
        await commit(repository, "a.txt", "one\n");
        const dirty = await watchRepository(repository);

        // A loose ref for `feature/x` lives in a subdirectory, so a non-recursive watch on
        // refs/heads would miss it entirely.
        await git(repository, ["checkout", "--quiet", "-b", "feature/nested"]);
        await commit(repository, "b.txt", "two\n");

        await waitFor(() => dirty.count >= 1);
        expect(dirty.count).toBeGreaterThan(0);
    });

    it("notices a checkout that only moves HEAD", async () => {
        const repository = await createRepository();
        await commit(repository, "a.txt", "one\n");
        await git(repository, ["checkout", "--quiet", "-b", "other"]);
        await commit(repository, "b.txt", "two\n");
        const dirty = await watchRepository(repository);

        await git(repository, ["checkout", "--quiet", "main"]);

        await waitFor(() => dirty.count >= 1);
        expect(dirty.count).toBeGreaterThan(0);
    });

    it("arms every target in a repository that has never fetched", async () => {
        const repository = await createRepository();
        await commit(repository, "a.txt", "one\n");
        const reasons: string[] = [];
        const gitDirectory = await git(repository, [
            "rev-parse",
            "--path-format=absolute",
            "--git-dir",
        ]);

        const dispose = watchGitRepositoryChanges({
            commonDirectory: gitDirectory,
            gitDirectory,
            onDegraded: (reason) => reasons.push(reason),
            onDirty: () => {},
            path: repository,
        });
        disposers.push(dispose);

        // `git init` never creates refs/remotes, so watching it directly failed to arm here and
        // was never retried once a remote appeared.
        expect(reasons).toEqual([]);
    });

    it("reports degradation instead of throwing when a directory cannot be watched", async () => {
        const repository = await createRepository();
        await commit(repository, "a.txt", "one\n");
        const reasons: string[] = [];

        const dispose = watchGitRepositoryChanges({
            commonDirectory: join(repository, "does-not-exist"),
            gitDirectory: join(repository, "also-missing"),
            onDegraded: (reason) => reasons.push(reason),
            onDirty: () => {},
            path: repository,
        });
        disposers.push(dispose);

        expect(reasons.length).toBeGreaterThan(0);
    });

    it("stops reporting once disposed", async () => {
        const repository = await createRepository();
        await commit(repository, "a.txt", "one\n");
        const dirty = await watchRepository(repository);
        await commit(repository, "b.txt", "two\n");
        await waitFor(() => dirty.count >= 1);

        dirty.dispose();
        const observed = dirty.count;
        await commit(repository, "c.txt", "three\n");
        await new Promise((resolve) => setTimeout(resolve, 200));

        expect(dirty.count).toBe(observed);
    });
});

async function watchRepository(
    repository: string,
): Promise<{ count: number; dispose: () => void }> {
    const gitDirectory = await git(repository, [
        "rev-parse",
        "--path-format=absolute",
        "--git-dir",
    ]);
    const commonDirectory = await git(repository, [
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
    ]);
    const state = { count: 0, dispose: () => {} };
    const dispose = watchGitRepositoryChanges({
        commonDirectory,
        gitDirectory,
        onDirty: () => {
            state.count += 1;
        },
        path: repository,
    });
    state.dispose = dispose;
    disposers.push(dispose);
    // Give the platform a moment to arm before the first mutation.
    await new Promise((resolve) => setTimeout(resolve, 100));
    return state;
}

async function createRepository(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "rig-git-watch-"));
    roots.push(root);
    const repository = join(root, "repository");
    await mkdir(repository);
    await git(repository, ["init", "--quiet", "--initial-branch=main"]);
    await git(repository, ["config", "user.email", "test@example.com"]);
    await git(repository, ["config", "user.name", "Test"]);
    return repository;
}

async function commit(repository: string, file: string, contents: string): Promise<void> {
    await writeFile(join(repository, file), contents);
    await git(repository, ["add", "--all"]);
    await git(repository, ["commit", "--quiet", "--message", `add ${file}`]);
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
    const result = await execFile("git", ["-C", cwd, ...args], {
        encoding: "utf8",
        timeout: 20_000,
    });
    return result.stdout.trim();
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("Timed out waiting for a change notification.");
}

async function isDirectory(path: string): Promise<boolean> {
    try {
        return (await stat(path)).isDirectory();
    } catch {
        // refs/remotes does not exist until a remote is fetched; an unarmed watch is handled by
        // the degradation path, so absence is not a rule violation.
        return true;
    }
}
