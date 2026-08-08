import { readGitWorktreeIdentity } from "./readGitWorktreeIdentity.js";
import { normalizeProjectCwd } from "../utils/normalizeProjectCwd.js";
import type { GitCommandRunner } from "./types.js";

/**
 * Moves a workspace's branch to a new name, checking first that it is renaming what it thinks.
 *
 * `git branch -m` is safe while the worktree is in use: the checkout keeps working and HEAD
 * follows the branch, so a running agent never notices. What is not safe is renaming a branch the
 * workspace is not on, so the worktree's own identity and current branch are read before the move
 * and the rename is skipped when Git is already there.
 */
export async function renameGitBranch(options: {
    /** Control directory the worktree must belong to. */
    expectedCommonDir: string;
    from: string;
    git: GitCommandRunner;
    to: string;
    workspacePath: string;
}): Promise<void> {
    if (options.from === options.to) return;
    const identity = await readGitWorktreeIdentity(options.git, options.workspacePath);
    if (identity.topLevel !== normalizeProjectCwd(options.workspacePath)) {
        throw new Error("The workspace is not the top level of its own worktree.");
    }
    if (identity.commonDir !== options.expectedCommonDir) {
        throw new Error("The workspace belongs to an unexpected repository.");
    }
    const current = await options.git(options.workspacePath, ["branch", "--show-current"]);
    if (current === options.to) return;
    if (current !== options.from) {
        throw new Error(
            current.length === 0
                ? `The workspace is on a detached HEAD rather than on '${options.from}'.`
                : `The workspace is on '${current}' rather than on '${options.from}'.`,
        );
    }
    await options.git(options.workspacePath, ["branch", "-m", options.from, options.to]);
}
