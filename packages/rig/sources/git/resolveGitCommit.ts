import type { GitCommandRunner } from "./types.js";

/**
 * Resolves a reference to the commit it names, lowercased.
 *
 * A workspace is anchored to an immutable commit rather than to the reference it was created from,
 * so a branch that moves afterwards cannot silently change what the workspace was based on. The
 * result is `undefined` when Git answers with anything that is not an object name, which lets the
 * caller phrase the failure in terms of what it was trying to do.
 */
export async function resolveGitCommit(
    git: GitCommandRunner,
    cwd: string,
    ref: string,
): Promise<string | undefined> {
    const commit = await git(cwd, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]);
    return /^[a-f0-9]{40,64}$/iu.test(commit) ? commit.toLocaleLowerCase() : undefined;
}
