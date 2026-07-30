import { readGitCommonDir } from "./readGitCommonDir.js";
import type { GitCommandRunner } from "./types.js";

/**
 * Removes a worktree from the repository that owns it and drops the administrative entry.
 *
 * Ownership is checked first. The repository at that path may have been replaced since the worktree
 * was created, and removing a worktree is a forced recursive delete of a directory Rig chose, so a
 * repository that no longer shares the recorded control directory is refused rather than asked to
 * delete something it does not know about.
 *
 * Pruning runs even when the directory is already gone, because that is exactly the case where Git
 * still holds a stale administrative entry for it.
 */
export async function removeGitWorktree(options: {
    /** Control directory the repository must still report, or it no longer owns this worktree. */
    expectedCommonDir: string;
    git: GitCommandRunner;
    /** Repository the worktree belongs to. */
    projectPath: string;
    /** False when the directory is already gone and only the administrative entry remains. */
    removeDirectory: boolean;
    workspacePath: string;
}): Promise<void> {
    const commonDir = await readGitCommonDir(options.git, options.projectPath);
    if (commonDir !== options.expectedCommonDir) {
        throw new Error("The source repository no longer owns this workspace.");
    }
    if (options.removeDirectory) {
        await options.git(options.projectPath, [
            "worktree",
            "remove",
            "--force",
            "--force",
            options.workspacePath,
        ]);
    }
    await options.git(options.projectPath, ["worktree", "prune"]);
}
