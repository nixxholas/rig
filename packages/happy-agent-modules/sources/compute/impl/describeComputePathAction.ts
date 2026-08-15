import { isProtectedGitControlPath } from "@slopus/happy-agent-compute";

import type { Compute } from "../Compute.js";
import { isPathInside, resolveComputePath } from "./resolveComputePath.js";

/**
 * The exact action a reviewer is deciding on, in a sentence: what is about to happen, to which
 * path, and which boundary that crosses. A path that will not resolve is quoted as the model
 * wrote it, because the proposal is what is being judged.
 */
export function describeComputePathAction(
    compute: Compute,
    path: string,
    operation: string,
    options: { write?: boolean } = {},
): string {
    let resolvedPath = path;
    try {
        resolvedPath = resolveComputePath(path, compute.cwd, compute.fs.home);
    } catch {
        // Keep the written path so the reviewer still sees what was proposed.
    }
    const access =
        options.write === true && isProtectedGitControlPath(resolvedPath)
            ? "protected Git control path requiring Full access"
            : isPathInside(compute.cwd, resolvedPath)
              ? "reviewed filesystem path requiring Full access after canonical path checks"
              : "unrestricted filesystem access outside the workspace sandbox";
    return `${operation} ${JSON.stringify(resolvedPath)}. Access: ${access}`;
}
