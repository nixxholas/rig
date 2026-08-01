import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { detectGitDefaultBranch } from "../detectGitDefaultBranch.js";

const execFile = promisify(execFileCallback);
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
    await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("detectGitDefaultBranch", () => {
    it("prefers the branch the remote calls its own default", async () => {
        const repository = await createRepository("origin-head", "main");
        await git(repository, ["branch", "trunk"]);
        await git(repository, ["update-ref", "refs/remotes/origin/trunk", "HEAD"]);
        await git(repository, [
            "symbolic-ref",
            "refs/remotes/origin/HEAD",
            "refs/remotes/origin/trunk",
        ]);

        expect(await detectGitDefaultBranch(git, repository)).toBe("trunk");
    });

    it("falls back to main, then master, then the branch the folder is on", async () => {
        const withMain = await createRepository("with-main", "main");
        await git(withMain, ["checkout", "-q", "-b", "feature"]);
        expect(await detectGitDefaultBranch(git, withMain)).toBe("main");

        const withMaster = await createRepository("with-master", "master");
        await git(withMaster, ["checkout", "-q", "-b", "feature"]);
        expect(await detectGitDefaultBranch(git, withMaster)).toBe("master");

        const neither = await createRepository("neither", "develop");
        expect(await detectGitDefaultBranch(git, neither)).toBe("develop");
    });

    it("names no branch outside a repository or on a detached HEAD", async () => {
        const root = await mkdtemp(join(tmpdir(), "rig-default-branch-"));
        cleanups.push(() => rm(root, { force: true, recursive: true }));
        const plain = join(root, "plain");
        await mkdir(plain);
        expect(await detectGitDefaultBranch(git, plain)).toBeUndefined();

        const detached = await createRepository("detached", "develop");
        await git(detached, ["checkout", "-q", "--detach", "HEAD"]);
        await git(detached, ["branch", "-D", "develop"]);
        expect(await detectGitDefaultBranch(git, detached)).toBeUndefined();
    });

    it("names the branch a repository without commits was initialized on", async () => {
        const root = await mkdtemp(join(tmpdir(), "rig-default-branch-"));
        cleanups.push(() => rm(root, { force: true, recursive: true }));
        const repository = join(root, "unborn");
        await mkdir(repository);
        await git(repository, ["init", "--initial-branch=main"]);

        expect(await detectGitDefaultBranch(git, repository)).toBe("main");
    });
});

async function createRepository(name: string, branch: string): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "rig-default-branch-"));
    cleanups.push(() => rm(root, { force: true, recursive: true }));
    const repository = join(root, name);
    await mkdir(repository, { recursive: true });
    await git(repository, ["init", `--initial-branch=${branch}`]);
    await git(repository, ["config", "user.email", "rig@example.test"]);
    await git(repository, ["config", "user.name", "Rig Test"]);
    await writeFile(join(repository, "README.md"), "fixture\n");
    await git(repository, ["add", "README.md"]);
    await git(repository, ["commit", "-m", "Initial"]);
    return repository;
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
    const result = await execFile("git", ["-C", cwd, ...args], {
        encoding: "utf8",
        timeout: 5_000,
    });
    return result.stdout.trim();
}
