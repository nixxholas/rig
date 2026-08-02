import { lstat, readlink, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, resolve, sep } from "node:path";

import { PluginWorkspaceOperationError } from "./PluginWorkspaceOperationError.js";
import { toPluginWorkspaceOperationError } from "./toPluginWorkspaceOperationError.js";

export async function resolvePluginWorkspaceFilePath(
    workspaceRoot: string,
    relativePath: string,
): Promise<string> {
    try {
        if (isAbsolute(relativePath)) {
            throw new PluginWorkspaceOperationError(
                "Plugin workspace file paths must be relative to the workspace.",
            );
        }
        const target = resolve(workspaceRoot, relativePath);
        let root: string;
        try {
            root = await realpath(workspaceRoot);
        } catch (error) {
            throw toPluginWorkspaceOperationError(error, "resolve");
        }
        try {
            const canonicalTarget = await resolvePotentialPath(target);
            if (canonicalTarget !== root && !canonicalTarget.startsWith(`${root}${sep}`)) {
                throw new PluginWorkspaceOperationError(
                    "Plugin workspace file paths cannot leave the workspace.",
                );
            }
        } catch (error) {
            throw toPluginWorkspaceOperationError(error, "path");
        }
        return target;
    } catch (error) {
        throw toPluginWorkspaceOperationError(error, "path");
    }
}

async function resolvePotentialPath(target: string, symlinkDepth = 0): Promise<string> {
    if (symlinkDepth > 40) {
        throw new PluginWorkspaceOperationError(
            "The workspace file path contains too many symbolic links.",
        );
    }
    const root = parse(target).root;
    const parts = target.slice(root.length).split(sep).filter(Boolean);
    let current = root;
    for (let index = 0; index < parts.length; index += 1) {
        const part = parts[index];
        if (part === undefined) continue;
        const candidate = join(current, part);
        try {
            const details = await lstat(candidate);
            if (details.isSymbolicLink()) {
                return resolvePotentialPath(
                    join(
                        resolve(dirname(candidate), await readlink(candidate)),
                        ...parts.slice(index + 1),
                    ),
                    symlinkDepth + 1,
                );
            }
            current = candidate;
        } catch (error) {
            if ((error as NodeJS.ErrnoException | null | undefined)?.code === "ENOENT") {
                return join(current, ...parts.slice(index));
            }
            throw error;
        }
    }
    return current;
}
