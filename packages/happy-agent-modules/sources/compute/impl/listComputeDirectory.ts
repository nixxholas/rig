import type { Context } from "@steve.kite/stdlib";

import type { Compute } from "../Compute.js";
import { computePermissionsForContext } from "./computePermissionsForContext.js";
import { joinComputePath, resolveComputePath } from "./resolveComputePath.js";

/** What one directory holds, as far as one listing goes. */
export interface ComputeDirectoryListing {
    readonly path: string;
    /** Sorted names, a directory's own name ending in a slash. */
    readonly entries: readonly string[];
    readonly totalEntries: number;
    readonly truncated: boolean;
}

/**
 * List one level of a directory.
 *
 * Sorted, because a listing that changes order between calls reads as a tree that changed. A
 * directory keeps its trailing slash so the model can tell at a glance what it can descend into.
 */
export async function listComputeDirectory(
    compute: Compute,
    ctx: Context,
    options: {
        readonly path?: string;
        readonly showHidden?: boolean;
        readonly maxEntries: number;
    },
): Promise<ComputeDirectoryListing> {
    const permissions = computePermissionsForContext(ctx);
    const directory = resolveComputePath(options.path ?? ".", compute.cwd, compute.fs.home);
    const stat = await compute.fs.stat(permissions, directory);
    if (!stat.isDirectory) throw new Error(`This path is not a directory: ${directory}`);
    const names = [...(await compute.fs.readdir(permissions, directory))]
        .filter((name) => options.showHidden === true || !name.startsWith("."))
        .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
    const shown = names.slice(0, options.maxEntries);
    const stats = await compute.fs.lstatMany(
        permissions,
        shown.map((name) => joinComputePath(directory, name)),
    );
    return {
        path: directory,
        entries: shown.map((name, index) =>
            stats[index]?.isDirectory === true ? `${name}/` : name,
        ),
        totalEntries: names.length,
        truncated: names.length > shown.length,
    };
}
