import { watch, type FSWatcher } from "node:fs";
import { join } from "node:path";

import type { RootContext } from "@steve.kite/stdlib";

const CONTROL_ENTRIES = new Set([
    "CHERRY_PICK_HEAD",
    "HEAD",
    "MERGE_HEAD",
    "ORIG_HEAD",
    "REBASE_HEAD",
    "REVERT_HEAD",
    "index",
]);
const COMMON_ENTRIES = new Set(["config", "packed-refs"]);

export interface GitRepositoryWatchOptions {
    commonDirectory: string;
    gitDirectory: string;
    onDirty: () => void;
    onDegraded?: (reason: string) => void;
    path: string;
}

export function watchGitRepositoryChanges(
    rootContext: RootContext,
    options: GitRepositoryWatchOptions,
): () => void {
    const watchContext = rootContext.named("git-repository-watch");
    const watchers: FSWatcher[] = [];
    let disposed = false;
    const dispose = () => {
        if (disposed) return;
        disposed = true;
        for (const watcher of watchers) {
            try {
                watcher.close();
            } catch {
                // The platform already closed this watcher.
            }
        }
        watchers.length = 0;
        watchContext.lifetime?.removeEventListener("abort", dispose);
    };
    watchContext.lifetime?.addEventListener("abort", dispose, { once: true });

    const arm = (
        directory: string,
        recursive: boolean,
        accept?: (entry: string) => boolean,
    ): void => {
        try {
            const watcher = watch(directory, { recursive }, (_event, filename) => {
                if (disposed) return;
                if (accept !== undefined) {
                    const entry = filename === null ? "" : String(filename);
                    if (!accept(entry)) return;
                }
                options.onDirty();
            });
            watcher.on("error", () => options.onDegraded?.(`Watching ${directory} stopped.`));
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
    options.onDirty();
    return dispose;
}

export interface GitWatchTarget {
    accept?: (entry: string) => boolean;
    directory: string;
    recursive: boolean;
}

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
    targets.push({ directory: join(options.commonDirectory, "refs"), recursive: true });
    if (supportsRecursiveWorktreeWatch()) {
        targets.push({ directory: options.path, recursive: true });
    }
    return targets;
}

export function supportsRecursiveWorktreeWatch(): boolean {
    return process.platform === "darwin" || process.platform === "win32";
}