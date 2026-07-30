export interface GitComparisonBase {
    /** Commit or tree the diff is taken against, absent when the comparison is unavailable. */
    base?: string;
    /** Human-readable explanation, present only when the comparison is unavailable. */
    error?: string;
}

export type GitBaseRunner = (args: readonly string[]) => Promise<string>;

/**
 * Chooses the tree a Git-status snapshot is measured against.
 *
 * A repository with commits measures against HEAD, matching `git status`. An unborn repository
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
    return { base: options.head };
}

async function tryRun(run: GitBaseRunner, args: readonly string[]): Promise<string | undefined> {
    try {
        return (await run(args)).trim();
    } catch {
        return undefined;
    }
}
