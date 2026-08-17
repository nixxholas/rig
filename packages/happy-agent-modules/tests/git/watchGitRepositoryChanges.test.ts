import { createRootContext } from "@steve.kite/stdlib";
import { afterEach, describe, expect, it } from "vitest";

import { readGitCommonDir } from "../../sources/git/readGitCommonDir.js";
import {
    gitWatchTargets,
    watchGitRepositoryChanges,
} from "../../sources/git/watchGitRepositoryChanges.js";
import { cleanupRoots, commitFile, createRepository, git, gitRunner } from "./helpers.js";

const disposers: (() => void)[] = [];
afterEach(async () => {
    for (const dispose of disposers.splice(0)) dispose();
    await cleanupRoots();
});

describe("watchGitRepositoryChanges", () => {
    it("watches replace-by-rename control files through their parent directories", async () => {
        const repository = await createRepository();
        await commitFile(repository, "README.md", "fixture\n");
        const commonDirectory = await readGitCommonDir(gitRunner, repository);
        const gitDirectory = await git(repository, [
            "rev-parse",
            "--path-format=absolute",
            "--git-dir",
        ]);
        const targets = gitWatchTargets({ commonDirectory, gitDirectory, path: repository });
        expect(targets.map((target) => target.directory)).toContain(gitDirectory);
        expect(targets.some((target) => target.directory.endsWith("/HEAD"))).toBe(false);
        expect(
            targets.find((target) => target.directory === `${commonDirectory}/refs`)?.recursive,
        ).toBe(true);
    });

    it("reconciles once after arming and stops after disposal", async () => {
        const repository = await createRepository();
        await commitFile(repository, "README.md", "fixture\n");
        const commonDirectory = await readGitCommonDir(gitRunner, repository);
        const gitDirectory = await git(repository, [
            "rev-parse",
            "--path-format=absolute",
            "--git-dir",
        ]);
        let dirty = 0;
        const dispose = watchGitRepositoryChanges(createRootContext(), {
            commonDirectory,
            gitDirectory,
            onDirty: () => {
                dirty += 1;
            },
            path: repository,
        });
        disposers.push(dispose);
        expect(dirty).toBe(1);
        dispose();
        const observed = dirty;
        await commitFile(repository, "later.txt", "later\n");
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(dirty).toBe(observed);
    });
});
