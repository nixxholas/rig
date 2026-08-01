import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { resolveWorkspaceBase } from "../resolveWorkspaceBase.js";
import type { GitCommandRunner } from "../types.js";

const execFile = promisify(execFileCallback);
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
    await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("resolveWorkspaceBase", () => {
    it("forks the remote trunk, not the local branch of the same name", async () => {
        const { clone, upstreamHead } = await createClone("trunk");

        const base = await resolveWorkspaceBase({
            defaultBranch: "main",
            git,
            projectPath: clone,
        });

        expect(base.ref).toBe("origin/main");
        expect(base.commit).toBe(upstreamHead);
        expect(base.commit).not.toBe((await git(clone, ["rev-parse", "HEAD"])).toLowerCase());
    });

    it("keeps working when the remote cannot be reached", async () => {
        const { clone } = await createClone("offline");
        await git(clone, ["remote", "set-url", "origin", join(clone, "nowhere.git")]);
        const known = (await git(clone, ["rev-parse", "origin/main"])).toLowerCase();

        const base = await resolveWorkspaceBase({
            defaultBranch: "main",
            git,
            projectPath: clone,
        });

        expect(base).toEqual({ commit: known, ref: "origin/main" });
    });

    it("falls back to the local trunk without an origin", async () => {
        const repository = await createRepository("local-only");
        const head = (await git(repository, ["rev-parse", "HEAD"])).toLowerCase();

        const base = await resolveWorkspaceBase({
            defaultBranch: "main",
            git,
            projectPath: repository,
        });

        expect(base).toEqual({ commit: head, ref: "main" });
    });

    it("uses an explicit base as given, and reaches the network only for a remote one", async () => {
        const { clone, upstreamHead } = await createClone("explicit");
        const localHead = (await git(clone, ["rev-parse", "HEAD"])).toLowerCase();
        const calls: string[][] = [];
        const recording: GitCommandRunner = async (cwd, args) => {
            calls.push([...args]);
            return git(cwd, args);
        };

        const local = await resolveWorkspaceBase({
            defaultBranch: "main",
            git: recording,
            projectPath: clone,
            requestedRef: "HEAD",
        });
        expect(local).toEqual({ commit: localHead, ref: "HEAD" });
        expect(calls.some((call) => call[0] === "fetch")).toBe(false);

        const remote = await resolveWorkspaceBase({
            defaultBranch: "main",
            git: recording,
            projectPath: clone,
            requestedRef: "origin/main",
        });
        expect(remote).toEqual({ commit: upstreamHead, ref: "origin/main" });
        expect(calls.some((call) => call[0] === "fetch")).toBe(true);
    });

    it("explains an unusable base instead of failing as a Git command", async () => {
        const repository = await createRepository("unusable");

        await expect(
            resolveWorkspaceBase({
                defaultBranch: "main",
                git,
                projectPath: repository,
                requestedRef: "no-such-ref",
            }),
        ).rejects.toThrow(/"no-such-ref" did not resolve to a commit/u);
        await expect(resolveWorkspaceBase({ git, projectPath: repository })).rejects.toThrow(
            /no branch to start a workspace from/u,
        );
        await expect(
            resolveWorkspaceBase({ defaultBranch: "absent", git, projectPath: repository }),
        ).rejects.toThrow(/"absent" has no commit to start a workspace from/u);
    });
});

/** Builds a clone whose origin has moved ahead and whose own checkout has a commit of its own. */
async function createClone(name: string): Promise<{ clone: string; upstreamHead: string }> {
    const root = await mkdtemp(join(tmpdir(), "rig-workspace-base-"));
    cleanups.push(() => rm(root, { force: true, recursive: true }));
    const upstream = join(root, "upstream");
    const remote = join(root, "remote.git");
    const clone = join(root, `${name}-clone`);
    await mkdir(upstream, { recursive: true });
    await mkdir(remote, { recursive: true });
    await initialCommit(upstream);
    await git(remote, ["init", "--bare", "--initial-branch=main"]);
    await git(upstream, ["remote", "add", "origin", remote]);
    await git(upstream, ["push", "-u", "origin", "main"]);
    await git(root, ["clone", remote, clone]);
    await configure(clone);

    await commit(upstream, "REMOTE.md", "remote\n", "Advance origin");
    await git(upstream, ["push", "origin", "main"]);
    await commit(clone, "LOCAL.md", "local\n", "Local only");
    await git(clone, ["fetch", "--quiet", "origin"]);
    await git(clone, ["update-ref", "refs/remotes/origin/main", "HEAD"]);

    return { clone, upstreamHead: (await git(upstream, ["rev-parse", "HEAD"])).toLowerCase() };
}

async function createRepository(name: string): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "rig-workspace-base-"));
    cleanups.push(() => rm(root, { force: true, recursive: true }));
    const repository = join(root, name);
    await mkdir(repository, { recursive: true });
    await initialCommit(repository);
    return repository;
}

async function initialCommit(path: string): Promise<void> {
    await git(path, ["init", "--initial-branch=main"]);
    await configure(path);
    await commit(path, "README.md", "fixture\n", "Initial");
}

async function configure(path: string): Promise<void> {
    await git(path, ["config", "user.email", "rig@example.test"]);
    await git(path, ["config", "user.name", "Rig Test"]);
}

async function commit(path: string, file: string, body: string, message: string): Promise<void> {
    await writeFile(join(path, file), body);
    await git(path, ["add", file]);
    await git(path, ["commit", "-m", message]);
}

const git: GitCommandRunner = async (cwd, args) => {
    const result = await execFile("git", ["-C", cwd, ...args], {
        encoding: "utf8",
        timeout: 10_000,
    });
    return result.stdout.trim();
};
