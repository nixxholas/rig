import { lstat, mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createGitWorktree } from "../../sources/modules/git/createGitWorktree.js";
import { isGitWorktreeAt } from "../../sources/modules/git/isGitWorktreeAt.js";
import { readGitCommonDir } from "../../sources/modules/git/readGitCommonDir.js";
import { removeGitWorktree } from "../../sources/modules/git/removeGitWorktree.js";
import {
    cleanupRoots,
    commitFile,
    createRepository,
    createRoot,
    gitRunner,
} from "./helpers.js";

afterEach(cleanupRoots);

describe("managed Git worktrees", () => {
    it("creates an anchored branch, proves identity, then removes and prunes it", async () => {
        const repository = await createRepository();
        const commit = await commitFile(repository, "README.md", "fixture\n");
        const commonDir = await readGitCommonDir(gitRunner, repository);
        const workspace = join(await createRoot(), "workspace");

        await createGitWorktree({
            branch: "worktree/feature",
            commit,
            expectedCommonDir: commonDir,
            git: gitRunner,
            projectPath: repository,
            workspacePath: workspace,
        });
        expect(await isGitWorktreeAt({ commonDir, git: gitRunner, path: workspace })).toBe(true);

        await removeGitWorktree({
            expectedCommonDir: commonDir,
            git: gitRunner,
            projectPath: repository,
            removeDirectory: true,
            workspacePath: workspace,
        });
        await expect(lstat(workspace)).rejects.toThrow();
    });

    it("refuses a symlink before asking Git to force-remove its target", async () => {
        const repository = await createRepository();
        await commitFile(repository, "README.md", "fixture\n");
        const commonDir = await readGitCommonDir(gitRunner, repository);
        const root = await createRoot();
        const target = join(root, "target");
        const link = join(root, "link");
        await mkdir(target);
        await symlink(target, link);

        await expect(
            removeGitWorktree({
                expectedCommonDir: commonDir,
                git: gitRunner,
                projectPath: repository,
                removeDirectory: true,
                workspacePath: link,
            }),
        ).rejects.toThrow("not a real directory");
    });
});