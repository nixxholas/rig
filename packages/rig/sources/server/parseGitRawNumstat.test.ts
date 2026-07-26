import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { parseGitRawNumstat } from "./parseGitRawNumstat.js";
import { runScanGit } from "./runScanGit.js";

const execFile = promisify(execFileCallback);
const roots: string[] = [];

afterEach(async () => {
    await Promise.allSettled(
        roots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
    );
});

describe("parseGitRawNumstat", () => {
    it("reports insertions and deletions for edits, additions, and deletions", async () => {
        const repository = await createRepository();
        await write(repository, "kept.txt", "a\nb\nc\n");
        await write(repository, "removed.txt", "gone\n");
        await commitAll(repository);
        await write(repository, "kept.txt", "a\nb\nc\nd\ne\n");
        await write(repository, "added.txt", "new\nlines\n");
        await git(repository, ["add", "added.txt"]);
        await write(repository, "untracked.txt", "never staged\n");
        await git(repository, ["rm", "--quiet", "removed.txt"]);

        const changes = await diff(repository);

        expect(byPath(changes, "kept.txt")).toMatchObject({
            binary: false,
            deletions: 0,
            insertions: 2,
            kind: "modified",
        });
        expect(byPath(changes, "added.txt")).toMatchObject({ insertions: 2, kind: "added" });
        expect(byPath(changes, "removed.txt")).toMatchObject({ deletions: 1, kind: "deleted" });
        // `git diff` never reports untracked files; the scanner counts those separately from
        // status, so a parser test must not pretend otherwise.
        expect(changes.map((change) => change.path)).not.toContain("untracked.txt");
    });

    it("keeps both paths of a rename without parsing the numstat arrow form", async () => {
        const repository = await createRepository();
        await write(repository, "we ird => name.txt", "x\n");
        await commitAll(repository);
        await mkdir(join(repository, "nested"), { recursive: true });
        await git(repository, [
            "mv",
            "we ird => name.txt",
            join("nested", "renamed with spaces.txt"),
        ]);

        const changes = await diff(repository);

        expect(changes).toHaveLength(1);
        expect(changes[0]).toMatchObject({
            kind: "renamed",
            path: "nested/renamed with spaces.txt",
            previousPath: "we ird => name.txt",
        });
    });

    it("aligns counts with paths when a rename appears beside ordinary edits", async () => {
        const repository = await createRepository();
        await write(repository, "alpha.txt", "1\n");
        await write(repository, "beta.txt", "1\n2\n");
        await write(repository, "gamma.txt", "1\n2\n3\n");
        await commitAll(repository);
        await git(repository, ["mv", "beta.txt", "delta.txt"]);
        await write(repository, "alpha.txt", "1\n2\n");
        await write(repository, "gamma.txt", "1\n");

        const changes = await diff(repository);

        expect(byPath(changes, "alpha.txt")).toMatchObject({ deletions: 0, insertions: 1 });
        expect(byPath(changes, "gamma.txt")).toMatchObject({ deletions: 2, insertions: 0 });
        expect(byPath(changes, "delta.txt")).toMatchObject({
            deletions: 0,
            insertions: 0,
            kind: "renamed",
            previousPath: "beta.txt",
        });
    });

    it("marks binary files without inventing line counts", async () => {
        const repository = await createRepository();
        await writeFile(join(repository, "image.bin"), Buffer.from([0, 1, 2, 3]));
        await commitAll(repository);
        await writeFile(join(repository, "image.bin"), Buffer.from([4, 5, 6, 7, 8]));

        const changes = await diff(repository);

        expect(changes[0]).toMatchObject({ binary: true, path: "image.bin" });
        expect(changes[0]?.insertions).toBeUndefined();
        expect(changes[0]?.deletions).toBeUndefined();
    });

    it("reports a submodule pointer change as a submodule rather than an edit", async () => {
        const inner = await createRepository();
        await write(inner, "a.txt", "one\n");
        await commitAll(inner);
        const outer = await createRepository();
        await write(outer, "root.txt", "root\n");
        await commitAll(outer);
        await git(outer, [
            "-c",
            "protocol.file.allow=always",
            "submodule",
            "--quiet",
            "add",
            inner,
            "child",
        ]);
        await commitAll(outer);
        await write(inner, "a.txt", "one\ntwo\n");
        await commitAll(inner);
        await git(join(outer, "child"), ["pull", "--quiet", "origin", "main"]);

        const changes = await diff(outer);

        expect(byPath(changes, "child")).toMatchObject({ kind: "submodule" });
        expect(byPath(changes, "child").insertions).toBeUndefined();
    });

    it("reports a file replaced by a symlink as a type change", async () => {
        const repository = await createRepository();
        await write(repository, "target.txt", "target\n");
        await write(repository, "swapped.txt", "plain\n");
        await commitAll(repository);
        await rm(join(repository, "swapped.txt"));
        await symlink("target.txt", join(repository, "swapped.txt"));

        const changes = await diff(repository);

        expect(byPath(changes, "swapped.txt").kind).toBe("type_changed");
    });

    it("covers staged, unstaged, and committed changes in one comparison", async () => {
        const repository = await createRepository();
        await write(repository, "base.txt", "1\n");
        await commitAll(repository);
        const base = await git(repository, ["rev-parse", "HEAD"]);
        await write(repository, "committed.txt", "c\n");
        await commitAll(repository);
        await write(repository, "staged.txt", "s\n");
        await git(repository, ["add", "staged.txt"]);
        await write(repository, "unstaged.txt", "u\n");
        await git(repository, ["add", "unstaged.txt"]);
        await write(repository, "unstaged.txt", "u\nmore\n");

        const changes = await diff(repository, base);

        expect(changes.map((change) => change.path).sort()).toEqual([
            "committed.txt",
            "staged.txt",
            "unstaged.txt",
        ]);
        expect(byPath(changes, "unstaged.txt").insertions).toBe(2);
    });

    it("returns nothing for a clean tree", async () => {
        const repository = await createRepository();
        await write(repository, "a.txt", "one\n");
        await commitAll(repository);

        expect(await diff(repository)).toEqual([]);
    });
});

async function diff(
    repository: string,
    base = "HEAD",
): Promise<readonly ReturnType<typeof parseGitRawNumstat>[number][]> {
    const result = await runScanGit({
        args: ["diff", "-z", "--raw", "--numstat", "--find-renames", base],
        cwd: repository,
    });
    return parseGitRawNumstat(result.stdout);
}

function byPath(
    changes: readonly ReturnType<typeof parseGitRawNumstat>[number][],
    path: string,
): ReturnType<typeof parseGitRawNumstat>[number] {
    const change = changes.find((candidate) => candidate.path === path);
    if (change === undefined) {
        throw new Error(
            `Expected a change for ${path}, saw ${changes.map((c) => c.path).join(", ")}`,
        );
    }
    return change;
}

async function createRepository(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "rig-git-diff-"));
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
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
    const result = await execFile("git", ["-C", cwd, ...args], {
        encoding: "utf8",
        timeout: 20_000,
    });
    return result.stdout.trim();
}
