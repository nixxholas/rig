import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { scanGitRepository } from "../scanGitRepository.js";

const execFile = promisify(execFileCallback);
const roots: string[] = [];

afterEach(async () => {
    await Promise.allSettled(
        roots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
    );
});

describe("scanGitRepository", () => {
    it("uses origin/main rather than local main as the branch baseline", async () => {
        const repository = await createRepository();
        await write(repository, "base.txt", "base\n");
        await commitAll(repository);
        const originMain = await git(repository, ["rev-parse", "HEAD"]);
        await git(repository, ["update-ref", "refs/remotes/origin/main", originMain]);
        await git(repository, ["checkout", "--quiet", "-b", "feature"]);
        await write(repository, "feature.txt", "feature\n");
        await commitAll(repository);
        const featureHead = await git(repository, ["rev-parse", "HEAD"]);

        await git(repository, ["checkout", "--quiet", "main"]);
        await write(repository, "local-main-only.txt", "local\n");
        await commitAll(repository);
        await git(repository, ["checkout", "--quiet", "feature"]);
        expect(await git(repository, ["rev-parse", "HEAD"])).toBe(featureHead);

        const snapshot = await scanGitRepository({ path: repository });

        expect(snapshot.base).toBe(originMain);
        expect(snapshot.files.map((change) => change.path)).toEqual(["feature.txt"]);
    });

    it("counts committed, staged, unstaged, and untracked work in one total", async () => {
        const repository = await createRepository();
        await write(repository, "base.txt", "1\n");
        await commitAll(repository);
        await write(repository, "committed.txt", "c1\nc2\n");
        await commitAll(repository);
        await write(repository, "staged.txt", "s1\n");
        await git(repository, ["add", "staged.txt"]);
        await write(repository, "unstaged.txt", "u1\nu2\nu3\n");
        await git(repository, ["add", "unstaged.txt"]);
        await write(repository, "untracked.txt", "n1\nn2\n");

        const snapshot = await scanGitRepository({ path: repository });

        expect(snapshot.comparison).toBe("ready");
        expect(snapshot.countsExact).toBe(true);
        expect(snapshot.changedFiles).toBe(4);
        expect(snapshot.insertions).toBe(2 + 1 + 3 + 2);
        expect(snapshot.deletions).toBe(0);
        expect(file(snapshot, "committed.txt")).toMatchObject({
            staged: false,
            unstaged: false,
        });
        expect(file(snapshot, "staged.txt")).toMatchObject({ staged: true });
        expect(file(snapshot, "untracked.txt")).toMatchObject({
            insertions: 2,
            status: "untracked",
        });
    });

    it("keeps committed work in the totals", async () => {
        const repository = await createRepository();
        await write(repository, "a.txt", "1\n");
        await commitAll(repository);
        await write(repository, "a.txt", "1\n2\n3\n");

        const dirty = await scanGitRepository({ path: repository });
        await commitAll(repository);
        const committed = await scanGitRepository({ path: repository });

        expect(dirty.insertions).toBe(2);
        expect(committed.insertions).toBe(2);
        expect(committed.changedFiles).toBe(1);
    });

    it("keeps committed branch work visible for a plain project", async () => {
        const repository = await createRepository();
        await write(repository, "a.txt", "1\n");
        await commitAll(repository);
        await write(repository, "a.txt", "1\n2\n");

        const dirty = await scanGitRepository({ path: repository });
        await commitAll(repository);
        const clean = await scanGitRepository({ path: repository });

        expect(dirty.insertions).toBe(1);
        expect(clean.changedFiles).toBe(1);
        expect(clean.insertions).toBe(1);
    });

    it("reports an unavailable comparison when origin/main is missing", async () => {
        const repository = await createRepository();
        await write(repository, "a.txt", "1\n");
        await commitAll(repository);
        await git(repository, ["update-ref", "-d", "refs/remotes/origin/main"]);
        await write(repository, "a.txt", "1\n2\n");

        const snapshot = await scanGitRepository({ path: repository });

        expect(snapshot.comparison).toBe("unavailable");
        expect(snapshot.error).toContain("remote main branch is unavailable");
        expect(snapshot.countsExact).toBe(false);
        expect(snapshot.changedFiles).toBe(0);
    });

    it("reports an unavailable comparison when history no longer connects", async () => {
        const repository = await createRepository();
        await write(repository, "a.txt", "1\n");
        await commitAll(repository);
        const unrelated = await createRepository();
        await write(unrelated, "b.txt", "2\n");
        await commitAll(unrelated);
        const foreign = await git(unrelated, ["rev-parse", "HEAD"]);
        await git(repository, ["fetch", "--quiet", unrelated, "main:refs/remotes/foreign/main"]);
        await git(repository, ["update-ref", "refs/remotes/origin/main", foreign]);

        const snapshot = await scanGitRepository({ path: repository });

        expect(snapshot.comparison).toBe("unavailable");
        expect(snapshot.error).toContain("no longer shares history with origin/main");
    });

    it("treats every file as added in a repository without commits", async () => {
        const repository = await createRepository();
        await write(repository, "a.txt", "1\n2\n");

        const snapshot = await scanGitRepository({ path: repository });

        expect(snapshot.comparison).toBe("ready");
        expect(snapshot.changedFiles).toBe(1);
        expect(snapshot.insertions).toBe(2);
        expect(snapshot.facts.head).toBeUndefined();
    });

    it("counts a final line that has no trailing newline", async () => {
        const repository = await createRepository();
        await write(repository, "seed.txt", "seed\n");
        await commitAll(repository);
        await write(repository, "unterminated.txt", "only line");

        const snapshot = await scanGitRepository({ path: repository });

        expect(file(snapshot, "unterminated.txt").insertions).toBe(1);
    });

    it("marks an untracked binary file without inventing counts", async () => {
        const repository = await createRepository();
        await write(repository, "seed.txt", "seed\n");
        await commitAll(repository);
        await writeFile(join(repository, "blob.bin"), Buffer.from([0, 1, 2, 3, 0]));

        const snapshot = await scanGitRepository({ path: repository });

        expect(file(snapshot, "blob.bin")).toMatchObject({ binary: true, status: "untracked" });
        expect(file(snapshot, "blob.bin").insertions).toBeUndefined();
        expect(snapshot.countsExact).toBe(true);
    });

    it("truncates the file list while keeping the totals exact", async () => {
        const repository = await createRepository();
        await write(repository, "seed.txt", "seed\n");
        await commitAll(repository);
        await mkdir(join(repository, "many"));
        await Promise.all(
            Array.from({ length: 1100 }, (_unused, index) =>
                write(repository, join("many", `f-${String(index).padStart(4, "0")}.txt`), "x\n"),
            ),
        );
        await git(repository, ["add", "--all"]);

        const snapshot = await scanGitRepository({ path: repository });

        expect(snapshot.changedFiles).toBe(1100);
        expect(snapshot.files).toHaveLength(1000);
        expect(snapshot.filesTruncated).toBe(true);
        expect(snapshot.insertions).toBe(1100);
        expect(snapshot.countsExact).toBe(true);
    });

    it("stops claiming exact counts once the untracked cap is reached", async () => {
        const repository = await createRepository();
        await write(repository, "seed.txt", "seed\n");
        await commitAll(repository);
        await mkdir(join(repository, "loose"));
        await Promise.all(
            Array.from({ length: 250 }, (_unused, index) =>
                write(repository, join("loose", `f-${String(index).padStart(4, "0")}.txt`), "x\n"),
            ),
        );

        const snapshot = await scanGitRepository({ path: repository });

        expect(snapshot.changedFiles).toBe(250);
        expect(snapshot.countsExact).toBe(false);
    });

    it("reports conflicted files during an unresolved merge", async () => {
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

        const snapshot = await scanGitRepository({ path: repository });

        expect(snapshot.conflicted).toBe(true);
        expect(file(snapshot, "conflict.txt").status).toBe("conflicted");
    });

    it("counts a staged deletion once even though Git also lists it as untracked", async () => {
        const repository = await createRepository();
        await write(repository, "removed.txt", "one\ntwo\n");
        await commitAll(repository);
        // `git rm --cached` leaves the file on disk, so porcelain v2 reports both a staged deletion
        // and an untracked file for the same path.
        await git(repository, ["rm", "--cached", "--quiet", "removed.txt"]);

        const snapshot = await scanGitRepository({ path: repository });

        expect(snapshot.changedFiles).toBe(1);
        expect(file(snapshot, "removed.txt")).toMatchObject({
            deletions: 2,
            insertions: 0,
            staged: true,
            status: "deleted",
        });
        expect(snapshot.insertions).toBe(0);
        expect(snapshot.deletions).toBe(2);
    });

    it("reports a clean tree as no change at all", async () => {
        const repository = await createRepository();
        await write(repository, "a.txt", "1\n");
        await commitAll(repository);

        const snapshot = await scanGitRepository({ path: repository });

        expect(snapshot).toMatchObject({
            changedFiles: 0,
            comparison: "ready",
            conflicted: false,
            countsExact: true,
            deletions: 0,
            filesTruncated: false,
            insertions: 0,
        });
        expect(snapshot.files).toEqual([]);
        expect(snapshot.facts.branch).toBe("main");
    });
});

function file(snapshot: Awaited<ReturnType<typeof scanGitRepository>>, path: string) {
    const found = snapshot.files.find((candidate) => candidate.path === path);
    if (found === undefined) {
        throw new Error(
            `Expected ${path}, saw ${snapshot.files.map((value) => value.path).join(", ")}`,
        );
    }
    return found;
}

async function createRepository(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "rig-scan-repo-"));
    roots.push(root);
    const repository = join(root, "repository");
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
    await git(repository, ["commit", "--quiet", "--allow-empty", "--message", "change"]);
    try {
        await git(repository, ["rev-parse", "--verify", "--quiet", "origin/main"]);
    } catch {
        const head = await git(repository, ["rev-parse", "HEAD"]);
        await git(repository, ["update-ref", "refs/remotes/origin/main", head]);
    }
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
    const result = await execFile("git", ["-C", cwd, ...args], {
        encoding: "utf8",
        timeout: 30_000,
    });
    return result.stdout.trim();
}
