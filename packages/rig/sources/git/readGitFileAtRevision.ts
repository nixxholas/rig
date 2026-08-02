import { runScanGit } from "./runScanGit.js";

export type GitRevisionFile =
    | { content: Buffer; found: true }
    | { content?: undefined; found: false };

/**
 * Reads one file's bytes as they were at a revision, which is what the old side of a diff is.
 *
 * A revision that does not hold the path is an answer, not a failure: a file added on the branch
 * legitimately has no version at the comparison base, and the caller has to be able to tell that
 * apart from a read that broke.
 *
 * `maximumBytes` is the ceiling on what Git may produce. Git streams a blob without announcing its
 * size, so a caller that must refuse oversized files asks for one byte more than it will accept and
 * refuses content that comes back longer.
 */
export async function readGitFileAtRevision(options: {
    maximumBytes: number;
    /** The checkout, and the directory `relativePath` is relative to. */
    path: string;
    /** Checkout-relative POSIX path. */
    relativePath: string;
    revision: string;
    signal?: AbortSignal;
}): Promise<GitRevisionFile> {
    assertRevision(options.revision);
    try {
        const result = await runScanGit({
            // `<revision>:./<path>` is resolved against the directory Git was pointed at, so a
            // project that sits inside a larger repository reads its own files rather than the
            // repository root's. `cat-file blob` is asked for instead of `show`, because `show`
            // answers for a directory with a tree listing that is not file content at all.
            args: ["cat-file", "blob", `${options.revision}:./${options.relativePath}`],
            cwd: options.path,
            maximumBytes: options.maximumBytes,
            ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
        return { content: result.stdoutBytes, found: true };
    } catch (error) {
        if (isMissingAtRevision(error)) return { found: false };
        throw error;
    }
}

/**
 * Git reads a leading dash as an option, and everything after the first colon of
 * `<revision>:<path>` as the path, so a revision carrying either would rewrite the command it is
 * placed in — including reading a path outside the folder the caller is scoped to.
 */
function assertRevision(revision: string): void {
    if (revision.length === 0) throw new Error("A Git revision is required.");
    if (revision.startsWith("-") || revision.includes(":")) {
        throw new Error("Rig cannot read a Git revision that starts with a dash or has a colon.");
    }
}

function isMissingAtRevision(error: unknown): boolean {
    if (typeof error !== "object" || error === null) return false;
    const stderr = String((error as { stderr?: unknown }).stderr ?? "");
    const message = error instanceof Error ? error.message : "";
    const details = `${message}\n${stderr}`;
    // Scans run with `LC_ALL=C`, so Git's wording here is the untranslated one. It has two of them:
    // one for a path the revision never had, and one for a path that exists only in the checkout.
    return details.includes("does not exist in") || details.includes("exists on disk, but not in");
}
