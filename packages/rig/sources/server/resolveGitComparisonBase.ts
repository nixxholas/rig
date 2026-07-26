export interface GitComparisonBase {
    /** Commit or tree the diff is taken against, absent when the comparison is unavailable. */
    base?: string;
    /** Human-readable explanation, present only when the comparison is unavailable. */
    error?: string;
}

export type GitBaseRunner = (args: readonly string[]) => Promise<string>;

/**
 * Chooses the commit a change snapshot is measured against.
 *
 * A managed workspace measures against the merge base of the commit it was created from and its
 * current HEAD, so its own commits count as work rather than disappearing. A plain project measures
 * against HEAD, so only the working tree counts.
 *
 * Resolution failure never falls back to HEAD. Doing so would render a workspace full of committed
 * work as an apparently clean tree — reporting zero for exactly the thing the feature exists to
 * measure — so an unresolvable base is reported as unavailable instead.
 */
export async function resolveGitComparisonBase(options: {
    /** Immutable commit the workspace was created from; absent for a plain project. */
    baseCommit?: string;
    /** Current HEAD, absent when the repository has no commits yet. */
    head?: string;
    run: GitBaseRunner;
}): Promise<GitComparisonBase> {
    if (options.head === undefined) {
        // An unborn HEAD has no commit to compare against, so everything present reads as added.
        const emptyTree = await tryRun(options.run, ["hash-object", "-t", "tree", "/dev/null"]);
        return emptyTree === undefined
            ? { error: "This repository has no commits yet." }
            : { base: emptyTree };
    }
    if (options.baseCommit === undefined) return { base: options.head };

    const present = await tryRun(options.run, [
        "rev-parse",
        "--verify",
        "--quiet",
        "--end-of-options",
        `${options.baseCommit}^{commit}`,
    ]);
    if (present === undefined || present.length === 0) {
        return {
            error: "The commit this workspace started from is no longer in the repository.",
        };
    }

    const mergeBase = await tryRun(options.run, [
        "merge-base",
        "--end-of-options",
        options.baseCommit,
        options.head,
    ]);
    if (mergeBase === undefined || mergeBase.length === 0) {
        // Git exits non-zero with no output when two commits share no history, which happens after
        // the base branch is rebuilt from unrelated history.
        return {
            error: "This workspace no longer shares history with the branch it started from.",
        };
    }
    return { base: mergeBase };
}

async function tryRun(run: GitBaseRunner, args: readonly string[]): Promise<string | undefined> {
    try {
        return (await run(args)).trim();
    } catch {
        return undefined;
    }
}
