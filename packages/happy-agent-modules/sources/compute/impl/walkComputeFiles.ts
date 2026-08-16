import type { ComputeFileSystem, ComputePermissions } from "../Compute.js";
import {
    isGitIgnored,
    loadInitialGitIgnoreScopes,
    readGitIgnoreScope,
    type GitIgnoreScope,
} from "./gitIgnore.js";
import { joinComputePath } from "./resolveComputePath.js";

/** One file the walk found, with what it needs to be ordered by recency. */
export interface WalkedFile {
    readonly path: string;
    readonly mtimeMs: number;
    readonly size: number;
}

/** What a walk found, and whether it saw the whole tree. */
export interface WalkedTree {
    readonly files: readonly WalkedFile[];
    /** The walk stopped at a limit, so a file it never reached may still match. */
    readonly truncated: boolean;
}

/** Directories whose contents are never what a search is looking for. */
const SKIPPED_DIRECTORIES = new Set([".git"]);

/** How many entries one search may look at before it answers with what it has. */
const MAX_VISITED_ENTRIES = 20_000;

/** How many files one search may carry back, whatever it then does with them. */
const MAX_COLLECTED_FILES = 10_000;

/**
 * Every file under a directory, breadth first, within a bound.
 *
 * Breadth first because a search that runs out of budget should have spent it near the top of the
 * tree, where the answer usually is, rather than deep inside the first branch it happened to
 * enter. Symbolic links are skipped and never followed, which keeps a cycle from turning the
 * walk into a loop. Git's own directory is skipped: it is large, it is never what was meant, and
 * finding a loose object by name helps nobody. The bounds belong to the walk rather than to what
 * the caller means to show, so a search keeps its whole budget for finding matches, and a walk
 * that stopped early says so — nothing should read a short answer as proof that nothing matches.
 */
export async function walkComputeFiles(
    fs: ComputeFileSystem,
    permissions: ComputePermissions,
    root: string,
    options: { respectGitIgnore?: boolean } = {},
): Promise<WalkedTree> {
    const files: WalkedFile[] = [];
    const respectGitIgnore = options.respectGitIgnore === true;
    const initialScopes = respectGitIgnore
        ? await loadInitialGitIgnoreScopes(fs, permissions, root)
        : [];
    const directories: { directory: string; scopes: readonly GitIgnoreScope[] }[] = [
        {
            directory: root,
            scopes: initialScopes,
        },
    ];
    let visited = 0;
    while (directories.length > 0) {
        const entry = directories.shift();
        if (entry === undefined) break;
        const { directory, scopes } = entry;
        let names: readonly string[];
        try {
            names = await fs.readdir(permissions, directory);
        } catch {
            // A directory that cannot be read is one the search simply does not cover.
            continue;
        }
        let currentScopes = scopes;
        if (
            respectGitIgnore &&
            names.includes(".gitignore") &&
            !scopes.some((scope) => scope.directory === directory)
        ) {
            const scope = await readGitIgnoreScope(fs, permissions, directory);
            if (scope !== undefined) currentScopes = [...scopes, scope];
        }
        const sorted = [...names].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
        const paths = sorted.map((name) => joinComputePath(directory, name));
        const stats = await fs.lstatMany(permissions, paths);
        for (const [index, path] of paths.entries()) {
            visited += 1;
            if (visited > MAX_VISITED_ENTRIES) return { files, truncated: true };
            const stat = stats[index];
            if (stat === undefined || stat.isSymbolicLink) continue;
            if (stat.isDirectory) {
                if (
                    !SKIPPED_DIRECTORIES.has(sorted[index] ?? "") &&
                    !(respectGitIgnore && isGitIgnored(path, true, currentScopes))
                ) {
                    directories.push({
                        directory: path,
                        scopes: currentScopes,
                    });
                }
                continue;
            }
            if (respectGitIgnore && isGitIgnored(path, false, currentScopes)) continue;
            files.push({ path, mtimeMs: stat.mtimeMs, size: stat.size });
            if (files.length >= MAX_COLLECTED_FILES) return { files, truncated: true };
        }
    }
    return { files, truncated: false };
}
