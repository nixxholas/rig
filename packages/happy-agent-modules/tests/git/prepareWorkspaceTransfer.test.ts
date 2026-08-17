import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { prepareWorkspaceTransfer } from "../../sources/git/prepareWorkspaceTransfer.js";
import { readGitCommonDir } from "../../sources/git/readGitCommonDir.js";
import { createGitWorktree } from "../../sources/git/createGitWorktree.js";
import {
    cleanupRoots,
    commitFile,
    createRepository,
    createRoot,
    git,
    gitRunner,
} from "./helpers.js";

afterEach(cleanupRoots);

describe("prepareWorkspaceTransfer", () => {
    it("overlays source work, honors .happyignore, always keeps .context, and rolls back", async () => {
        const repository = await createRepository();
        const base = await commitFile(repository, "base.txt", "base\n");
        const commonDir = await readGitCommonDir(gitRunner, repository);
        const target = join(await createRoot(), "target");
        await createGitWorktree({
            branch: "worktree/target",
            commit: base,
            expectedCommonDir: commonDir,
            git: gitRunner,
            projectPath: repository,
            workspacePath: target,
        });
        await git(repository, ["checkout", "--quiet", "-b", "source"]);
        await commitFile(repository, "committed.txt", "committed\n");
        await writeFile(join(repository, "loose.txt"), "loose\n");
        await writeFile(join(repository, "ignored.txt"), "ignored\n");
        await writeFile(join(repository, ".happyignore"), "ignored.txt\n.context/\n");
        await mkdir(join(repository, ".context"));
        await writeFile(join(repository, ".context", "note.txt"), "context\n");

        const prepared = await prepareWorkspaceTransfer({
            git: gitRunner,
            sourcePath: repository,
            targetPath: target,
        });
        expect(await readFile(join(target, "loose.txt"), "utf8")).toBe("loose\n");
        await expect(readFile(join(target, "ignored.txt"))).rejects.toThrow();
        expect(await readFile(join(target, ".context", "note.txt"), "utf8")).toBe("context\n");

        await prepared.rollback(new Error("test rollback"));
        await expect(readFile(join(target, "loose.txt"))).rejects.toThrow();
        expect(prepared.state).toMatchObject({ status: "failed", target: "restored" });
    });

    it("matches v1 ignore semantics and carries tracked deletions into the target", async () => {
        const repository = await createRepository();
        const base = await commitFile(repository, "base.txt", "base\n");
        const commonDir = await readGitCommonDir(gitRunner, repository);
        const target = join(await createRoot(), "target");
        await createGitWorktree({
            branch: "worktree/ignore-fixtures",
            commit: base,
            expectedCommonDir: commonDir,
            git: gitRunner,
            projectPath: repository,
            workspacePath: target,
        });
        await git(repository, ["checkout", "--quiet", "-b", "source-ignore-fixtures"]);
        await writeFile(join(repository, "removed.txt"), "remove me\n");
        await git(repository, ["add", "removed.txt"]);
        await git(repository, ["commit", "--quiet", "--message", "tracked deletion fixture"]);
        await rm(join(repository, "removed.txt"));

        await Promise.all([
            mkdir(join(repository, "nested"), { recursive: true }),
            mkdir(join(repository, "foo", "deep"), { recursive: true }),
            mkdir(join(repository, "negated"), { recursive: true }),
            mkdir(join(repository, "ignored-dir"), { recursive: true }),
            mkdir(join(repository, ".context"), { recursive: true }),
        ]);
        await Promise.all([
            writeFile(join(repository, "cache.txt"), "root globstar\n"),
            writeFile(join(repository, "nested", "cache.txt"), "nested globstar\n"),
            writeFile(join(repository, "foo", "secret.txt"), "zero-depth globstar\n"),
            writeFile(join(repository, "foo", "deep", "secret.txt"), "nested globstar\n"),
            writeFile(join(repository, "literal*.txt"), "escaped wildcard\n"),
            writeFile(join(repository, "!important.txt"), "escaped negation\n"),
            writeFile(join(repository, "#notes.txt"), "escaped comment\n"),
            writeFile(join(repository, "a.txt"), "character class\n"),
            writeFile(join(repository, "negated", "drop.txt"), "ignored\n"),
            writeFile(join(repository, "negated", "keep.txt"), "kept\n"),
            writeFile(join(repository, "ignored-dir", "drop.txt"), "directory only\n"),
            writeFile(join(repository, ".context", "note.txt"), "always copied\n"),
        ]);
        await writeFile(
            join(repository, ".happyignore"),
            [
                "**/cache.txt",
                "foo/**/secret.txt",
                String.raw`literal\*.txt`,
                String.raw`\!important.txt`,
                String.raw`\#notes.txt`,
                "[ab].txt",
                "ignored-dir/",
                "negated/*",
                "!negated/keep.txt",
                ".context/",
                "",
            ].join("\n"),
        );

        const prepared = await prepareWorkspaceTransfer({
            git: gitRunner,
            sourcePath: repository,
            targetPath: target,
        });

        for (const relativePath of [
            "cache.txt",
            "nested/cache.txt",
            "foo/secret.txt",
            "foo/deep/secret.txt",
            "literal*.txt",
            "!important.txt",
            "#notes.txt",
            "a.txt",
            "negated/drop.txt",
            "ignored-dir/drop.txt",
            "removed.txt",
        ]) {
            await expect(access(join(target, relativePath))).rejects.toThrow();
        }
        expect(await readFile(join(target, "negated", "keep.txt"), "utf8")).toBe("kept\n");
        expect(await readFile(join(target, ".context", "note.txt"), "utf8")).toBe(
            "always copied\n",
        );
        await prepared.commitTransfer();
    });
});
