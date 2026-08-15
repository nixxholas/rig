import type { ComputeFileSystem, ComputePermissions } from "../Compute.js";
import { basenameComputePath, joinComputePath, parentComputePath } from "./resolveComputePath.js";

/**
 * Where a path really leads, with every symbolic link on the way followed.
 *
 * A boundary drawn on the written path alone is not a boundary: a link inside the workspace can
 * name anything on the machine, and a write through it would look like a write to the workspace.
 * A path that does not exist yet cannot be resolved at all, so its parent is resolved instead —
 * which is exactly the case of creating a file inside a directory that is itself a link out.
 * When even that fails there is nothing left to learn, and the written path is answered as it
 * stands, leaving the caller to treat it as the outside.
 */
export async function canonicalComputePath(
    fs: ComputeFileSystem,
    permissions: ComputePermissions,
    path: string,
): Promise<string> {
    try {
        return await fs.realpath(permissions, path);
    } catch {
        // The path does not exist yet, which is ordinary for a file about to be created.
    }
    const parent = parentComputePath(path);
    if (parent === path) return path;
    try {
        return joinComputePath(
            await fs.realpath(permissions, parent),
            basenameComputePath(path),
        );
    } catch {
        return path;
    }
}
