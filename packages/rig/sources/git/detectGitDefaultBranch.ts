import type { GitCommandRunner } from "./types.js";

/**
 * Decides which branch a repository considers its trunk.
 *
 * A workspace is cut from the project's trunk rather than from whatever the project folder happens
 * to be checked out on, so the trunk has to be named once and remembered. `origin/HEAD` is asked
 * first because it is the remote's own answer and is the only source that is right for a repository
 * whose trunk is neither `main` nor `master`. Nothing here talks to the network: a project must not
 * hang on an unreachable remote or a credential prompt while it is being added.
 *
 * The result is `undefined` only when nothing names a branch at all, such as a repository sitting on
 * a detached HEAD with neither `main` nor `master`.
 */
export async function detectGitDefaultBranch(
    git: GitCommandRunner,
    path: string,
): Promise<string | undefined> {
    const run = async (args: readonly string[]): Promise<string | undefined> => {
        try {
            const output = (await git(path, args)).trim();
            return output.length === 0 ? undefined : output;
        } catch {
            return undefined;
        }
    };

    const originHead = await run([
        "symbolic-ref",
        "--quiet",
        "--short",
        "refs/remotes/origin/HEAD",
    ]);
    if (originHead !== undefined && originHead.startsWith("origin/")) {
        return originHead.slice("origin/".length);
    }
    for (const candidate of ["main", "master"]) {
        const known =
            (await run(["rev-parse", "--verify", "--quiet", `refs/heads/${candidate}`])) ??
            (await run(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${candidate}`]));
        if (known !== undefined) return candidate;
    }
    return await run(["symbolic-ref", "--quiet", "--short", "HEAD"]);
}
