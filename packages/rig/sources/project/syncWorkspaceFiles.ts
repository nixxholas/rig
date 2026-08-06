import { cp, mkdir, realpath, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import { resolvePotentialPath } from "../agent/context/resolvePotentialPath.js";

/**
 * Copies configured project files into a workspace, the root copy winning.
 *
 * Sync shares files the checkout cannot provide, such as gitignored `.env` files, by replicating
 * the project root's copy into every workspace — first when the workspace is created, then again
 * whenever the root copy changes. Replication is one-way and best-effort: the root always wins,
 * a path that cannot be read or written right now is simply skipped until the next pass, and
 * nothing is ever deleted in a workspace because it disappeared from the root.
 *
 * The workspace is another party's writable space, so the destination is re-resolved before every
 * copy: a workspace that replaced a destination ancestor with a symlink pointing elsewhere gets
 * that path skipped rather than making the daemon write outside the workspace. A workspace whose
 * folder no longer exists — archived while a sync was in flight — is left alone, never recreated.
 */
export async function syncWorkspaceFiles(options: {
    /** Project-relative paths to replicate, already validated to stay inside the project. */
    paths: readonly string[];
    projectPath: string;
    workspacePath: string;
}): Promise<void> {
    let workspaceRoot: string;
    try {
        workspaceRoot = await realpath(options.workspacePath);
    } catch {
        return;
    }
    for (const path of new Set(options.paths)) {
        const source = resolve(options.projectPath, path);
        const destination = resolve(options.workspacePath, path);
        if (
            !isPathLexicallyWithin(options.projectPath, source) ||
            !isPathLexicallyWithin(options.workspacePath, destination)
        ) {
            throw new Error(`Workspace sync path "${path}" must stay inside the project.`);
        }
        try {
            const canonicalDestination = await resolvePotentialPath(destination);
            if (!isPathLexicallyWithin(workspaceRoot, canonicalDestination)) continue;
            const sourceMetadata = await statOrUndefined(source);
            if (sourceMetadata === undefined) continue;
            await mkdir(dirname(canonicalDestination), { recursive: true });
            // Removing first replaces the destination even when its kind changed, such as a file
            // where the root now has a directory, instead of merging or failing on the mismatch.
            await rm(canonicalDestination, { force: true, recursive: true });
            await cp(source, canonicalDestination, {
                dereference: true,
                force: true,
                recursive: true,
            });
        } catch {
            // Best-effort per path: this one converges on a later pass, the rest still copy.
        }
    }
}

function isPathLexicallyWithin(parent: string, target: string): boolean {
    const fromParent = relative(parent, target);
    return (
        fromParent !== "" &&
        fromParent !== ".." &&
        !fromParent.startsWith(`..${sep}`) &&
        !isAbsolute(fromParent)
    );
}

/** Reads the sync source following symlinks, treating an unreachable path as a missing one. */
async function statOrUndefined(path: string): Promise<{ isDirectory(): boolean } | undefined> {
    try {
        return await stat(path);
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ENOTDIR") return undefined;
        throw error;
    }
}
