import { watch, type FSWatcher } from "node:fs";
import { join } from "node:path";

/** Entries in a Git directory whose change means HEAD, the index, or an in-progress operation moved. */
const CONTROL_ENTRIES = new Set([
    "CHERRY_PICK_HEAD",
    "HEAD",
    "MERGE_HEAD",
    "ORIG_HEAD",
    "REBASE_HEAD",
    "REVERT_HEAD",
    "index",
]);

/** Entries in the common Git directory that affect refs or upstream configuration. */
const COMMON_ENTRIES = new Set(["config", "packed-refs"]);

export interface GitRepositoryWatchOptions {
    /** Common Git directory, shared by a repository and all of its linked worktrees. */
    commonDirectory: string;
    /** Per-worktree Git directory; equals the common directory for a plain repository. */
    gitDirectory: string;
    onDirty: () => void;
    /** Reports that a watch could not be armed, so the caller can rely on its poll instead. */
    onDegraded?: (reason: string) => void;
    /** Working tree root. */
    path: string;
}

/**
 * Watches the few places that reveal a repository changed.
 *
 * Watches are armed on *directories*, never on the control files themselves. Git replaces `HEAD`,
 * `index`, and `packed-refs` by writing a lock file and renaming it over the target, and a file
 * watch follows the original inode — so a watch on `HEAD` sees the first commit and then silently
 * observes a dead inode forever.
 *
 * Ref directories are watched recursively because a loose ref for `feature/x` lives in a
 * subdirectory, and remote refs are included so a fetch updates ahead/behind.
 *
 * A recursive working-tree watch is armed only where the kernel provides one. On Linux it is
 * emulated by arming an inotify watch per directory, including every directory of `node_modules`,
 * so the caller's reconciliation poll covers working-tree edits there instead.
 */
export function watchGitRepositoryChanges(options: GitRepositoryWatchOptions): () => void {
    const watchers: FSWatcher[] = [];
    const arm = (
        directory: string,
        recursive: boolean,
        accept?: (entry: string) => boolean,
    ): void => {
        try {
            const watcher = watch(directory, { recursive }, (_event, filename) => {
                if (accept !== undefined) {
                    const entry = filename === null ? "" : String(filename);
                    if (!accept(entry)) return;
                }
                options.onDirty();
            });
            watcher.on("error", () => {
                options.onDegraded?.(`Watching ${directory} stopped.`);
            });
            watcher.unref?.();
            watchers.push(watcher);
        } catch (error) {
            options.onDegraded?.(
                `Watching ${directory} is unavailable: ${error instanceof Error ? error.message : "unknown error"}`,
            );
        }
    };

    for (const target of gitWatchTargets(options)) {
        arm(target.directory, target.recursive, target.accept);
    }

    // `fs.watch` has no readiness event. Reconcile once after all watches are installed so a
    // mutation that races the caller's preceding scan with kernel watch activation is not lost.
    // GitStateTracker coalesces this with any notification that is already pending.
    options.onDirty();

    return () => {
        for (const watcher of watchers) {
            try {
                watcher.close();
            } catch {
                // A watcher already torn down by the platform needs no further cleanup.
            }
        }
        watchers.length = 0;
    };
}

export interface GitWatchTarget {
    /** Filters the directory's entries down to the ones worth reacting to. */
    accept?: (entry: string) => boolean;
    directory: string;
    recursive: boolean;
}

/**
 * The directories a repository watch is armed on.
 *
 * Exported so the "always a directory, never a control file" rule can be asserted directly. That
 * rule cannot be observed behaviourally on macOS, where Node's FSEvents backend resolves a watch by
 * path and therefore survives Git's lock-file rename; on Linux the same watch is bound to the inode
 * and goes silent after the first commit.
 */
export function gitWatchTargets(options: {
    commonDirectory: string;
    gitDirectory: string;
    path: string;
}): readonly GitWatchTarget[] {
    const shared = options.commonDirectory === options.gitDirectory;
    const targets: GitWatchTarget[] = [
        {
            accept: (entry) => CONTROL_ENTRIES.has(entry) || (shared && COMMON_ENTRIES.has(entry)),
            directory: options.gitDirectory,
            recursive: false,
        },
    ];
    if (!shared) {
        targets.push({
            accept: (entry) => COMMON_ENTRIES.has(entry),
            directory: options.commonDirectory,
            recursive: false,
        });
    }
    // The whole ref root rather than heads and remotes separately: `refs/remotes` does not exist
    // until the first fetch, so watching it directly fails to arm in a fresh clone-less repository
    // and never retries once a remote appears.
    targets.push({ directory: join(options.commonDirectory, "refs"), recursive: true });
    if (supportsRecursiveWorktreeWatch()) {
        targets.push({ directory: options.path, recursive: true });
    }
    return targets;
}

/**
 * Recursive watching is kernel-backed on macOS and Windows. Node emulates it on Linux by walking
 * the tree and arming one inotify watch per directory, which would consume the user's shared
 * `max_user_watches` budget on `node_modules` alone.
 */
export function supportsRecursiveWorktreeWatch(): boolean {
    return process.platform === "darwin" || process.platform === "win32";
}
