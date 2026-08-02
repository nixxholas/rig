import { isAbsolute, relative } from "node:path";

import type { AgentContext } from "../../agent/context/AgentContext.js";
import { resolveFileSystemPath } from "../../agent/context/resolveFileSystemPath.js";

const BOUNDARY_ERROR =
    "Shared local paths must be inside the active workspace or Rig-generated media directory.";

/** Enforces the same lexical and canonical sharing boundary for files and imported folders. */
export async function assertShareableLocalPath(
    requestedPath: string,
    context: AgentContext,
): Promise<string> {
    const requested = resolveFileSystemPath(requestedPath, context.fs.cwd, context.fs.home);
    const directories = [
        context.fs.cwd,
        ...(context.generatedMedia === undefined ? [] : [context.generatedMedia.modelDirectory]),
    ];
    if (!directories.some((directory) => isPathInsideDirectory(directory, requested))) {
        throw new Error(BOUNDARY_ERROR);
    }
    const canonical = await context.fs.realpath(requested);
    for (const directory of directories) {
        try {
            if (isPathInsideDirectory(await context.fs.realpath(directory), canonical)) {
                return canonical;
            }
        } catch {
            // A generated-media directory that does not exist cannot contain this existing path.
        }
    }
    throw new Error(BOUNDARY_ERROR);
}

function isPathInsideDirectory(directory: string, path: string): boolean {
    const pathFromDirectory = relative(directory, path);
    return (
        pathFromDirectory === "" ||
        (!pathFromDirectory.startsWith("..") && !isAbsolute(pathFromDirectory))
    );
}
