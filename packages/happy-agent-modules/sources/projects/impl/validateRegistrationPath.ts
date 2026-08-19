import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { join } from "node:path";

import type { GitModule } from "../../git/index.js";
import { ProjectRegistrationError } from "../ProjectRegistrationError.js";

/**
 * Checks a folder someone asked to register explicitly.
 *
 * Any readable directory is a project, whether it is an ordinary folder, a Git repository root,
 * or a subdirectory inside a larger Git working tree. Git inspection decides separately whether
 * child workspaces can use worktrees or must be copied directories.
 */
export async function validateRegistrationPath(
    git: Pick<GitModule, "normalizeProjectCwd" | "topLevel">,
    requestedPath: string,
): Promise<string> {
    let details;
    try {
        details = await stat(requestedPath);
    } catch (error) {
        if (isMissingPathError(error)) {
            throw new ProjectRegistrationError(
                "path_missing",
                "The project folder does not exist.",
            );
        }
        throw new ProjectRegistrationError(
            "path_inaccessible",
            "The project folder is not accessible.",
        );
    }
    if (!details.isDirectory()) {
        throw new ProjectRegistrationError("not_directory", "The project path is not a folder.");
    }
    try {
        await access(requestedPath, constants.R_OK | constants.X_OK);
    } catch {
        throw new ProjectRegistrationError(
            "path_inaccessible",
            "The project folder is not accessible.",
        );
    }

    const path = git.normalizeProjectCwd(requestedPath);
    try {
        const gitMetadata = await stat(join(path, ".git"));
        await access(
            join(path, ".git"),
            gitMetadata.isDirectory() ? constants.R_OK | constants.X_OK : constants.R_OK,
        );
    } catch (error) {
        if (!isMissingPathError(error)) {
            throw new ProjectRegistrationError(
                "path_inaccessible",
                "The Git repository is not accessible.",
            );
        }
    }
    try {
        await git.topLevel(path);
    } catch (error) {
        if (isInaccessiblePathError(error)) {
            throw new ProjectRegistrationError(
                "path_inaccessible",
                "The Git repository is not accessible.",
            );
        }
        // A readable ordinary folder is a complete project. Git inspection later persists the
        // explicit unsupported-worktree reason that makes workspace creation choose a copy.
        return path;
    }
    return path;
}

function isMissingPathError(error: unknown): boolean {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    return code === "ENOENT" || code === "ENOTDIR";
}

function isInaccessiblePathError(error: unknown): boolean {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code === "EACCES" || code === "EPERM") return true;
    const message = error instanceof Error ? error.message : String(error);
    // Git's own verdict wins. A read-only scan runs Git inside the shared sandbox, and the shell
    // that carries it may complain about a start-up file of the person's it is not allowed to
    // read. That complaint rides along on the same stream and must not turn "this folder is not a
    // repository" into "this repository cannot be reached".
    if (/not a git repository/iu.test(message)) return false;
    return /(?:permission denied|operation not permitted|could not open|unable to access|unsafe repository|dubious ownership)/iu.test(
        message,
    );
}
