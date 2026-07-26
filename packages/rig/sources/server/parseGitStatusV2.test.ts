import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { parseGitStatusV2, type GitStatusV2 } from "./parseGitStatusV2.js";
import { runScanGit } from "./runScanGit.js";

const execFile = promisify(execFileCallback);
const roots: string[] = [];

afterEach(async () => {
    await Promise.allSettled(
        roots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
    );
});

describe("parseGitStatusV2", () => {
    it("separates staged, unstaged, and untracked work", async () => {
        const repository = await createRepository();
        await write(repository, "staged.txt", "one\n");
        await write(repository, "unstaged.txt", "one\n");
        await write(repository, "both.txt", "one\n");
        await commitAll(repository);
        await write(repository, "staged.txt", "one\ntwo\n");
        await git(repository, ["add", "staged.txt"]);
        await write(repository, "unstaged.txt", "one\ntwo\n");
        await write(repository, "both.txt", "one\ntwo\n");
        await git(repository, ["add", "both.txt"]);
        await write(repository, "both.txt", "one\ntwo\nthree\n");
        await write(repository, "fresh.txt", "new\n");

        const status = await scan(repository);

        expect(entry(status, "staged.txt")).toMatchObject({ staged: true, unstaged: false });
        expect(entry(status, "unstaged.txt")).toMatchObject({ staged: false, unstaged: true });
        expect(entry(status, "both.txt")).toMatchObject({ staged: true, unstaged: true });
        expect(entry(status, "fresh.txt")).toMatchObject({ untracked: true, staged: false });
    });

    it("lists every untracked file inside an untracked directory", async () => {
        const repository = await createRepository();
        await write(repository, "a.txt", "one\n");
        await commitAll(repository);
        await mkdir(join(repository, "nested", "deeper"), { recursive: true });
        await write(repository, join("nested", "one.txt"), "1\n");
        await write(repository, join("nested", "deeper", "two.txt"), "2\n");

        const status = await scan(repository);

        expect(
            status.entries
                .filter((value) => value.untracked)
                .map((value) => value.path)
                .sort(),
        ).toEqual(["nested/deeper/two.txt", "nested/one.txt"]);
    });

    it("keeps both paths of a rename and survives awkward file names", async () => {
        const repository = await createRepository();
        await write(repository, "a file with spaces.txt", "one\n");
        await commitAll(repository);
        await git(repository, ["mv", "a file with spaces.txt", "renamed 'quoted'.txt"]);

        const status = await scan(repository);

        expect(entry(status, "renamed 'quoted'.txt")).toMatchObject({
            from: "a file with spaces.txt",
            staged: true,
        });
    });

    it("reports branch, upstream, and divergence", async () => {
        const origin = await createRepository();
        await write(origin, "a.txt", "one\n");
        await commitAll(origin);
        const clone = join(await createRoot(), "clone");
        await execFile("git", ["clone", "--quiet", origin, clone]);
        await git(clone, ["config", "user.email", "test@example.com"]);
        await git(clone, ["config", "user.name", "Test"]);
        await write(origin, "a.txt", "one\ntwo\n");
        await commitAll(origin);
        await write(clone, "b.txt", "local\n");
        await commitAll(clone);
        await git(clone, ["fetch", "--quiet", "origin"]);

        const status = await scan(clone);

        expect(status.branch).toBe("main");
        expect(status.upstream).toBe("origin/main");
        expect(status.ahead).toBe(1);
        expect(status.behind).toBe(1);
        expect(status.detached).toBe(false);
        expect(status.head).toMatch(/^[0-9a-f]{40}$/u);
    });

    it("reports a detached HEAD without a branch", async () => {
        const repository = await createRepository();
        await write(repository, "a.txt", "one\n");
        await commitAll(repository);
        const head = await git(repository, ["rev-parse", "HEAD"]);
        await git(repository, ["checkout", "--quiet", "--detach", head]);

        const status = await scan(repository);

        expect(status.branch).toBeUndefined();
        expect(status.detached).toBe(true);
        expect(status.head).toBe(head);
    });

    it("reports an unborn HEAD as neither detached nor committed", async () => {
        const repository = await createRepository();
        await write(repository, "a.txt", "one\n");

        const status = await scan(repository);

        expect(status.head).toBeUndefined();
        expect(status.detached).toBe(false);
        expect(status.branch).toBe("main");
        expect(entry(status, "a.txt").untracked).toBe(true);
    });

    it("marks conflicted files as unmerged during a failed merge", async () => {
        const repository = await createRepository();
        await write(repository, "conflict.txt", "base\n");
        await commitAll(repository);
        await git(repository, ["checkout", "--quiet", "-b", "other"]);
        await write(repository, "conflict.txt", "other\n");
        await commitAll(repository);
        await git(repository, ["checkout", "--quiet", "main"]);
        await write(repository, "conflict.txt", "main\n");
        await commitAll(repository);
        await expect(git(repository, ["merge", "--no-edit", "other"])).rejects.toThrow();

        const status = await scan(repository);

        expect(entry(status, "conflict.txt")).toMatchObject({ unmerged: true, unstaged: true });
    });
});

async function scan(repository: string): Promise<GitStatusV2> {
    const result = await runScanGit({
        args: ["status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all"],
        cwd: repository,
    });
    return parseGitStatusV2(result.stdout);
}

function entry(status: GitStatusV2, path: string) {
    const found = status.entries.find((candidate) => candidate.path === path);
    if (found === undefined) {
        throw new Error(
            `Expected an entry for ${path}, saw ${status.entries.map((e) => e.path).join(", ")}`,
        );
    }
    return found;
}

async function createRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "rig-git-status-"));
    roots.push(root);
    return root;
}

async function createRepository(): Promise<string> {
    const repository = join(await createRoot(), "repository");
    await mkdir(repository);
    await git(repository, ["init", "--quiet", "--initial-branch=main"]);
    await git(repository, ["config", "user.email", "test@example.com"]);
    await git(repository, ["config", "user.name", "Test"]);
    return repository;
}

async function write(repository: string, file: string, contents: string): Promise<void> {
    await writeFile(join(repository, file), contents);
}

async function commitAll(repository: string): Promise<void> {
    await git(repository, ["add", "--all"]);
    await git(repository, ["commit", "--quiet", "--message", "change"]);
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
    const result = await execFile("git", ["-C", cwd, ...args], {
        encoding: "utf8",
        timeout: 20_000,
    });
    return result.stdout.trim();
}
