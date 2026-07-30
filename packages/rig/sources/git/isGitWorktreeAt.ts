import { normalizeProjectCwd } from "../utils/normalizeProjectCwd.js";
import { readGitWorktreeIdentity } from "./readGitWorktreeIdentity.js";
import type { GitCommandRunner } from "./types.js";

/**
 * Reports whether a directory is a complete worktree of one specific repository.
 *
 * A directory left behind by an interrupted creation looks like a worktree from the outside, so
 * both halves have to agree: the directory must be the root of its own working tree, and that tree
 * must belong to the repository Rig recorded. Anything Git refuses to answer means "no", because
 * the only use of the answer is deciding whether the directory can be adopted or must be rebuilt.
 */
export async function isGitWorktreeAt(options: {
    /** Control directory the worktree is expected to belong to. */
    commonDir: string;
    git: GitCommandRunner;
    path: string;
}): Promise<boolean> {
    try {
        const identity = await readGitWorktreeIdentity(options.git, options.path);
        return (
            identity.topLevel === normalizeProjectCwd(options.path) &&
            identity.commonDir === options.commonDir
        );
    } catch {
        return false;
    }
}
