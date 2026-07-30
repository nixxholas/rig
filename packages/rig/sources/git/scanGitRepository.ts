import { statSync } from "node:fs";
import { join } from "node:path";

import type {
    GitChangeState,
    GitFileChange,
    GitFileChangeStatus,
    GitRepositoryFacts,
} from "../protocol/index.js";
import { countUntrackedFileLines } from "./countUntrackedFileLines.js";
import { errorToMessage } from "../errorToMessage.js";
import { parseGitRawNumstat, type GitDiffChange } from "./parseGitRawNumstat.js";
import { parseGitStatusV2, type GitStatusEntry, type GitStatusV2 } from "./parseGitStatusV2.js";
import { resolveGitComparisonBase } from "./resolveGitComparisonBase.js";
import { runScanGit } from "./runScanGit.js";

const FILE_LIST_LIMIT = 1000;
const UNTRACKED_COUNT_LIMIT = 200;
const UNTRACKED_BYTE_LIMIT = 1024 * 1024;
/**
 * A scan reruns when the repository moved underneath it. Three attempts is enough to get a coherent
 * read of a tree an agent is actively writing; beyond that the tracker's next dirty signal will
 * scan again anyway, so the last attempt is accepted rather than looping.
 */
const CONSISTENCY_ATTEMPTS = 3;

export interface ScanGitRepositoryOptions {
    now?: () => number;
    path: string;
    signal?: AbortSignal;
}

/**
 * Produces one branch-change snapshot: what differs from the merge base with origin/main.
 *
 * Committed, staged, unstaged, and untracked work all count toward the same totals.
 */
export async function scanGitRepository(
    options: ScanGitRepositoryOptions,
): Promise<GitChangeState> {
    const now = options.now ?? Date.now;
    const run = async (args: readonly string[]): Promise<string> => {
        const result = await runScanGit({
            args,
            cwd: options.path,
            ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
        return result.stdout;
    };

    const gitDirectory = await resolveGitDirectory(run);
    let last: GitChangeState | undefined;
    for (let attempt = 0; attempt < CONSISTENCY_ATTEMPTS; attempt += 1) {
        const before = indexFingerprint(gitDirectory);
        const scanned = await scanOnce(options, run, now);
        const after = indexFingerprint(gitDirectory);
        last = scanned;
        // The diff and the untracked counts are separate reads. If the index or HEAD moved between
        // them the result mixes two different trees, so it is rescanned rather than published.
        if (before === after) return scanned;
    }
    return last!;
}

async function scanOnce(
    options: ScanGitRepositoryOptions,
    run: (args: readonly string[]) => Promise<string>,
    now: () => number,
): Promise<GitChangeState> {
    let status: GitStatusV2;
    let statusTruncated = false;
    try {
        const result = await runScanGit({
            args: ["status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all"],
            cwd: options.path,
            ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
        // A truncated status silently drops files and staging flags, so the totals derived from it
        // can never be called exact.
        statusTruncated = result.truncated;
        // A truncated stream ends mid-record, so its last entry is a partial path that was never
        // a real file. Reporting it would put a fabricated name in front of the user.
        status = parseGitStatusV2(
            result.truncated
                ? result.stdout.slice(0, result.stdout.lastIndexOf("\0") + 1)
                : result.stdout,
        );
    } catch (error) {
        return failed(emptyFacts(), errorToMessage(error), now());
    }

    const facts = factsFromStatus(status);
    const conflicted = status.entries.some((entry) => entry.unmerged);
    const comparison = await resolveGitComparisonBase({
        ...(status.head === undefined ? {} : { head: status.head }),
        run: async (args) => await run(args),
    });
    if (comparison.base === undefined) {
        return {
            changedFiles: 0,
            comparison: "unavailable",
            conflicted,
            countsExact: false,
            deletions: 0,
            error: comparison.error ?? "The comparison base is unavailable.",
            facts,
            files: [],
            filesTruncated: false,
            insertions: 0,
            scannedAt: now(),
        };
    }

    let diff: readonly GitDiffChange[];
    let countsExact = !statusTruncated;
    try {
        const result = await runScanGit({
            args: ["diff", "-z", "--raw", "--numstat", "--find-renames", comparison.base],
            cwd: options.path,
            ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
        // A truncated stream ends mid-record, so its trailing partial field is not a real path.
        diff = parseGitRawNumstat(
            result.truncated
                ? result.stdout.slice(0, result.stdout.lastIndexOf("\0") + 1)
                : result.stdout,
        );
        // A truncated diff cannot be completed after the fact, so the totals stop claiming to be
        // exact rather than silently under-reporting.
        if (result.truncated) countsExact = false;
    } catch (error) {
        return failed(facts, errorToMessage(error), now(), conflicted);
    }

    // One path can appear twice in status: `git rm --cached` leaves a staged deletion *and* an
    // untracked file for the same name. The tracked record wins, so the staged deletion is not
    // relabelled as an ordinary new file.
    const staging = new Map<string, GitStatusEntry>();
    for (const entry of status.entries) {
        const existing = staging.get(entry.path);
        if (existing === undefined || (existing.untracked && !entry.untracked)) {
            staging.set(entry.path, entry);
        }
    }
    const changes: GitFileChange[] = diff.map((change) =>
        trackedChange(change, staging.get(change.path)),
    );

    // The same duplication would otherwise count that path twice: once as a deletion from the diff
    // and once as an addition from the untracked list, so a tree identical to the base reports
    // changes in both directions.
    const diffPaths = new Set(diff.map((change) => change.path));
    const untracked = status.entries.filter(
        (entry) => entry.untracked && !diffPaths.has(entry.path),
    );
    let counted = 0;
    for (const entry of untracked) {
        if (counted >= UNTRACKED_COUNT_LIMIT) {
            countsExact = false;
            changes.push(untrackedChange(entry.path, { binary: false, inexact: true }));
            continue;
        }
        counted += 1;
        const count = await countUntrackedFileLines(
            join(options.path, entry.path),
            UNTRACKED_BYTE_LIMIT,
        );
        if (count.inexact) countsExact = false;
        changes.push(untrackedChange(entry.path, count));
    }

    // Conflicted paths are absent from the diff against a base that predates the merge, so they are
    // added from status to keep the file list complete. The set keeps this linear at the file cap.
    const presentPaths = new Set(changes.map((change) => change.path));
    for (const entry of status.entries) {
        if (!entry.unmerged || presentPaths.has(entry.path)) continue;
        presentPaths.add(entry.path);
        changes.push({
            binary: false,
            path: entry.path,
            staged: false,
            status: "conflicted",
            unstaged: true,
        });
    }

    let insertions = 0;
    let deletions = 0;
    for (const change of changes) {
        insertions += change.insertions ?? 0;
        deletions += change.deletions ?? 0;
    }

    changes.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
    return {
        base: comparison.base,
        changedFiles: changes.length,
        comparison: "ready",
        conflicted,
        countsExact,
        deletions,
        facts,
        // Truncating the list never changes the totals above, which are summed over every change.
        files: changes.slice(0, FILE_LIST_LIMIT),
        filesTruncated: changes.length > FILE_LIST_LIMIT,
        insertions,
        scannedAt: now(),
    };
}

function trackedChange(change: GitDiffChange, staging: GitStatusEntry | undefined): GitFileChange {
    const status: GitFileChangeStatus =
        staging?.unmerged === true ? "conflicted" : (change.kind satisfies GitFileChangeStatus);
    return {
        binary: change.binary,
        ...(change.deletions === undefined ? {} : { deletions: change.deletions }),
        ...(change.insertions === undefined ? {} : { insertions: change.insertions }),
        path: change.path,
        ...(change.previousPath === undefined ? {} : { previousPath: change.previousPath }),
        // A file changed only by a commit appears in no staging area, which is correct: it is
        // already committed work.
        staged: staging?.staged ?? false,
        status,
        unstaged: staging?.unstaged ?? false,
    };
}

function untrackedChange(
    path: string,
    count: { binary: boolean; inexact: boolean; insertions?: number },
): GitFileChange {
    return {
        binary: count.binary,
        ...(count.insertions === undefined ? {} : { deletions: 0, insertions: count.insertions }),
        path,
        staged: false,
        status: "untracked",
        unstaged: true,
    };
}

function factsFromStatus(status: GitStatusV2): GitRepositoryFacts {
    return {
        ahead: status.ahead,
        behind: status.behind,
        ...(status.branch === undefined ? {} : { branch: status.branch }),
        detached: status.detached,
        ...(status.head === undefined ? {} : { head: status.head }),
        ...(status.upstream === undefined ? {} : { upstream: status.upstream }),
    };
}

function emptyFacts(): GitRepositoryFacts {
    return { ahead: 0, behind: 0, detached: false };
}

function failed(
    facts: GitRepositoryFacts,
    error: string,
    scannedAt: number,
    conflicted = false,
): GitChangeState {
    return {
        changedFiles: 0,
        comparison: "unavailable",
        conflicted,
        countsExact: false,
        deletions: 0,
        error,
        facts,
        files: [],
        filesTruncated: false,
        insertions: 0,
        scannedAt,
    };
}

async function resolveGitDirectory(
    run: (args: readonly string[]) => Promise<string>,
): Promise<string | undefined> {
    try {
        const directory = (await run(["rev-parse", "--path-format=absolute", "--git-dir"])).trim();
        return directory.length === 0 ? undefined : directory;
    } catch {
        return undefined;
    }
}

/**
 * Cheap witness that the repository has not moved during a scan. Git rewrites the index and HEAD by
 * renaming a lock file over them, so both size and modification time change on every update.
 */
function indexFingerprint(gitDirectory: string | undefined): string {
    if (gitDirectory === undefined) return "";
    return [join(gitDirectory, "index"), join(gitDirectory, "HEAD")]
        .map((path) => {
            try {
                const stats = statSync(path);
                return `${String(stats.size)}:${String(stats.mtimeMs)}`;
            } catch {
                return "missing";
            }
        })
        .join("|");
}
