import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { probeGitRepository } from "./probeGitRepository.js";

const execFile = promisify(execFileCallback);
const roots: string[] = [];

afterEach(async () => {
    await Promise.allSettled(
        roots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
    );
});

describe("probeGitRepository", () => {
    it("reports a repository root as able to host a workspace and captures its branch", async () => {
        const repository = await createRepository();
        await commit(repository, "a.txt", "one\n");

        const probe = await probeGitRepository({ git, path: repository });

        expect(probe.presence).toBe("present");
        expect(probe.worktreeSupport).toBe("supported");
        expect(probe.worktreeSupportReason).toBeUndefined();
        expect(probe.facts?.branch).toBe("main");
        expect(probe.facts?.detached).toBe(false);
        expect(probe.facts?.head).toMatch(/^[0-9a-f]{40}$/u);
        expect(probe.facts?.upstream).toBeUndefined();
        expect(probe.facts?.ahead).toBe(0);
        expect(probe.facts?.behind).toBe(0);
    });

    it("reports a directory that is not a repository", async () => {
        const root = await createRoot();

        const probe = await probeGitRepository({ git, path: root });

        expect(probe).toMatchObject({
            presence: "present",
            worktreeSupport: "unsupported",
            worktreeSupportReason: "This folder is not a Git repository.",
        });
    });

    it("reports a directory nested inside a repository", async () => {
        const repository = await createRepository();
        await commit(repository, "a.txt", "one\n");
        const nested = join(repository, "nested");
        await mkdir(nested);

        const probe = await probeGitRepository({ git, path: nested });

        expect(probe).toMatchObject({
            presence: "present",
            worktreeSupport: "unsupported",
            worktreeSupportReason: "This folder is inside a Git repository but is not its root.",
        });
    });

    it("refuses a repository without commits because a worktree needs one", async () => {
        const repository = await createRepository();

        const probe = await probeGitRepository({ git, path: repository });

        expect(probe).toMatchObject({
            presence: "present",
            worktreeSupport: "unsupported",
            worktreeSupportReason: "This repository has no commits yet.",
        });
        expect(probe.facts?.head).toBeUndefined();
        expect(probe.facts?.detached).toBe(false);
    });

    it("reports a detached HEAD without a branch", async () => {
        const repository = await createRepository();
        await commit(repository, "a.txt", "one\n");
        const head = await git(repository, ["rev-parse", "HEAD"]);
        await git(repository, ["checkout", "--detach", head]);

        const probe = await probeGitRepository({ git, path: repository });

        expect(probe.worktreeSupport).toBe("supported");
        expect(probe.facts?.branch).toBeUndefined();
        expect(probe.facts?.detached).toBe(true);
        expect(probe.facts?.head).toBe(head);
    });

    it("counts divergence from an upstream branch", async () => {
        const origin = await createRepository();
        await commit(origin, "a.txt", "one\n");
        const clone = join(await createRoot(), "clone");
        await execFile("git", ["clone", "--quiet", origin, clone]);
        await git(clone, ["config", "user.email", "test@example.com"]);
        await git(clone, ["config", "user.name", "Test"]);
        await commit(origin, "a.txt", "one\ntwo\n");
        await commit(clone, "b.txt", "local\n");
        await git(clone, ["fetch", "--quiet", "origin"]);

        const probe = await probeGitRepository({ git, path: clone });

        expect(probe.facts?.upstream).toBe("origin/main");
        expect(probe.facts?.ahead).toBe(1);
        expect(probe.facts?.behind).toBe(1);
    });

    it("explains that a bare repository cannot host a worktree", async () => {
        const root = await createRoot();
        const bare = join(root, "bare.git");
        await mkdir(bare);
        await git(bare, ["init", "--quiet", "--bare"]);

        const probe = await probeGitRepository({ git, path: bare });

        // `rev-parse --show-toplevel` fails in a bare repository, so a probe that checked for bare
        // only afterwards reported "not a Git repository" instead.
        expect(probe).toMatchObject({
            presence: "present",
            worktreeSupport: "unsupported",
            worktreeSupportReason: "This is a bare Git repository.",
        });
    });

    it("reports a directory that no longer exists as missing", async () => {
        const root = await createRoot();
        const removed = join(root, "gone");

        const probe = await probeGitRepository({ git, path: removed });

        expect(probe).toMatchObject({
            presence: "missing",
            worktreeSupport: "unsupported",
            worktreeSupportReason: "This folder no longer exists.",
        });
        expect(probe.facts).toBeUndefined();
    });

    it("never offers worktrees for the home project even when it is a repository", async () => {
        const repository = await createRepository();
        await commit(repository, "a.txt", "one\n");

        const probe = await probeGitRepository({ git, isHome: true, path: repository });

        expect(probe).toMatchObject({
            presence: "present",
            worktreeSupport: "unsupported",
            worktreeSupportReason: "Worktrees cannot be created from your home folder.",
        });
    });
});

async function createRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "rig-git-probe-"));
    roots.push(root);
    return root;
}

async function createRepository(): Promise<string> {
    const root = await createRoot();
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
        timeout: 10_000,
    });
    return result.stdout.trim();
}
