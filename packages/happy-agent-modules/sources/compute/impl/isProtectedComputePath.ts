import { isPathInside } from "./resolveComputePath.js";

/**
 * Whether the machine guards this path even inside the workspace. The compute names them — Git
 * control files, the project configuration that grants network access — and a change to one is
 * reviewed however ordinary the file looks.
 */
export function isProtectedComputePath(path: string, protectedPaths: readonly string[]): boolean {
    return protectedPaths.some((protectedPath) => isPathInside(protectedPath, path));
}
