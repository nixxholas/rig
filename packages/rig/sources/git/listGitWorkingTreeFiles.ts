import { runScanGit } from "./runScanGit.js";

/**
 * The most paths one enumeration reports. It holds an ordinary checkout whole, and a tree large
 * enough to pass it is a tree no client can render anyway; the excess is reported as truncated
 * rather than silently dropped, so nobody shows a prefix of a repository as if it were all of it.
 */
const WORKING_TREE_FILE_LIMIT = 20_000;

export interface GitWorkingTreeFiles {
    /** Checkout-relative POSIX paths, sorted. */
    paths: string[];
    /** True when the checkout holds more files than `paths` carries. */
    truncated: boolean;
}

/**
 * Lists every file in a checkout: what Git tracks, plus what Git would offer to add.
 *
 * Git is asked rather than the directory walked, so `.gitignore`, nested ignore files, and the
 * control directory are honored exactly as they are in the changed-file list, with none of it
 * reimplemented here.
 *
 * A folder that is not a repository is an ordinary state — a workspace copied instead of forked is
 * one — so it answers with no files. Any other Git failure is a real failure and is raised.
 */
export async function listGitWorkingTreeFiles(options: {
    path: string;
    signal?: AbortSignal;
}): Promise<GitWorkingTreeFiles> {
    let result;
    try {
        result = await runScanGit({
            args: ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
            cwd: options.path,
            ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
    } catch (error) {
        if (isMissingRepository(error)) return { paths: [], truncated: false };
        throw error;
    }

    // A truncated stream ends mid-record, so its last entry is a partial path that was never a real
    // file. Reporting it would put a fabricated name in front of the user.
    const stdout = result.truncated
        ? result.stdout.slice(0, result.stdout.lastIndexOf("\0") + 1)
        : result.stdout;
    // An unmerged path is listed once per merge stage, and `git rm --cached` leaves a path both
    // tracked and untracked, so the same name arrives more than once.
    const paths = [...new Set(stdout.split("\0").filter((path) => path.length > 0))].sort(
        (left, right) => (left < right ? -1 : left > right ? 1 : 0),
    );
    return {
        paths: paths.slice(0, WORKING_TREE_FILE_LIMIT),
        truncated: result.truncated || paths.length > WORKING_TREE_FILE_LIMIT,
    };
}

function isMissingRepository(error: unknown): boolean {
    if (typeof error !== "object" || error === null) return false;
    const stderr = String((error as { stderr?: unknown }).stderr ?? "");
    const message = error instanceof Error ? error.message : "";
    // Scans run with `LC_ALL=C`, so Git's wording here is the untranslated one.
    return `${message}\n${stderr}`.includes("not a git repository");
}
