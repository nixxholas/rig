import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { join } from "node:path";

import type { GitModule } from "../../git/index.js";
import { ProjectRegistrationError } from "../ProjectRegistrationError.js";

/**
 * Checks a folder someone asked to register explicitly.
 *
 * Registration is deliberate, so it is held to a stricter standard than the folder a session
 * happens to start in. A Git folder must be the canonical root of its working tree; a readable
 * ordinary directory is also a project, and its workspaces are copied directories.
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
    let topLevel: string;
    try {
        topLevel = await git.topLevel(path);
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
    if (topLevel !== path) {
        throw new ProjectRegistrationError(
            "not_git_top_level",
            "Choose the Git repository's top-level folder.",
        );
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
