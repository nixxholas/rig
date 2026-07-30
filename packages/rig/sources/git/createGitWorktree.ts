import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import { normalizeProjectCwd } from "../utils/normalizeProjectCwd.js";
import { readGitWorktreeIdentity } from "./readGitWorktreeIdentity.js";
import type { GitCommandRunner } from "./types.js";

/**
 * Creates a worktree on its own branch at an exact path, then proves Git did what was asked.
 *
 * A worktree is always a branch, so the branch is created with it rather than checked out
 * afterwards. Git resolves the destination itself and will happily place a worktree somewhere Rig
 * did not intend — inside an existing one, or from a repository that is not the source — so both
 * halves of the resulting identity are verified before the worktree is treated as usable.
 *
 * The initial fetch runs only when the repository has an `origin`, because a local-only repository
 * would otherwise fail creation on a step that exists purely to make the new branch start out
 * up to date.
 */
export async function createGitWorktree(options: {
    /** Branch created with the worktree; it must not already exist. */
    branch: string;
    /** Immutable commit the branch starts from. */
    commit: string;
    /** Control directory the new worktree must belong to. */
    expectedCommonDir: string;
    git: GitCommandRunner;
    /** Repository the worktree is cut from. */
    projectPath: string;
    /** Exact path the worktree must occupy. */
    workspacePath: string;
}): Promise<void> {
    await mkdir(dirname(options.workspacePath), { recursive: true, mode: 0o700 });
    await options.git(options.projectPath, [
        "worktree",
        "add",
        "-b",
        options.branch,
        "--",
        options.workspacePath,
        options.commit,
    ]);
    const identity = await readGitWorktreeIdentity(options.git, options.workspacePath);
    if (identity.topLevel !== normalizeProjectCwd(options.workspacePath)) {
        throw new Error("Git created the worktree at an unexpected path.");
    }
    if (identity.commonDir !== options.expectedCommonDir) {
        throw new Error("Git created the worktree from an unexpected repository.");
    }
    let hasOrigin = true;
    try {
        await options.git(options.workspacePath, ["remote", "get-url", "origin"]);
    } catch {
        hasOrigin = false;
    }
    if (hasOrigin) {
        await options.git(options.workspacePath, ["fetch", "origin"]);
    }
}
