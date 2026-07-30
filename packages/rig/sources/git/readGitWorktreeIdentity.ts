import { readGitCommonDir } from "./readGitCommonDir.js";
import { readGitTopLevel } from "./readGitTopLevel.js";
import type { GitCommandRunner } from "./types.js";

export interface GitWorktreeIdentity {
    /** Control directory shared with every other worktree of the same repository. */
    commonDir: string;
    /** Root of this worktree's working tree. */
    topLevel: string;
}

/**
 * Reads both halves of a worktree's identity: where its working tree starts and which repository it
 * belongs to. Together they answer "is this directory the worktree we think it is", which no single
 * Git question does.
 */
export async function readGitWorktreeIdentity(
    git: GitCommandRunner,
    path: string,
): Promise<GitWorktreeIdentity> {
    const topLevel = await readGitTopLevel(git, path);
    const commonDir = await readGitCommonDir(git, path);
    return { commonDir, topLevel };
}
