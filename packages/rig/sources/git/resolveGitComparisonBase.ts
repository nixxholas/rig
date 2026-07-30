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
 * Every branch measures against its merge base with `origin/main`, so committed branch work stays
 * visible and changes made only on local `main` never leak into the snapshot. An unborn repository
 * measures against Git's empty tree so every present file reads as added.
 */
export async function resolveGitComparisonBase(options: {
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
    const originMain = await tryRun(options.run, [
        "rev-parse",
        "--verify",
        "--quiet",
        "--end-of-options",
        "origin/main^{commit}",
    ]);
    if (originMain === undefined || originMain.length === 0) {
        return { error: "The remote main branch is unavailable." };
    }
    const mergeBase = await tryRun(options.run, [
        "merge-base",
        "--end-of-options",
        originMain,
        options.head,
    ]);
    return mergeBase === undefined || mergeBase.length === 0
        ? { error: "This branch no longer shares history with origin/main." }
        : { base: mergeBase };
}

async function tryRun(run: GitBaseRunner, args: readonly string[]): Promise<string | undefined> {
    try {
        return (await run(args)).trim();
    } catch {
        return undefined;
    }
}
