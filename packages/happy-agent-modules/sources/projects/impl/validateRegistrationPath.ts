import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { join } from "node:path";

import { normalizeProjectCwd } from "../../git/normalizeProjectCwd.js";
import { readGitTopLevel } from "../../git/readGitTopLevel.js";
import type { GitCommandRunner } from "../../git/GitCommandRunner.js";
import { ProjectRegistrationError } from "../ProjectRegistrationError.js";

/**
 * Checks a folder someone asked to register explicitly.
 *
 * Registration is deliberate, so it is held to a stricter standard than the folder a session
 * happens to start in: the stored identity is always the canonical root of one working tree. A
 * linked worktree is its own valid top-level folder.
 */
export async function validateRegistrationPath(
    git: GitCommandRunner,
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

    const path = normalizeProjectCwd(requestedPath);
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
        topLevel = await readGitTopLevel(git, path);
    } catch (error) {
        if (isInaccessiblePathError(error)) {
            throw new ProjectRegistrationError(
                "path_inaccessible",
                "The Git repository is not accessible.",
            );
        }
        throw new ProjectRegistrationError(
            "not_git_repository",
            "The project folder is not a Git repository.",
        );
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
    return /(?:permission denied|operation not permitted|could not open|unable to access|unsafe repository|dubious ownership)/iu.test(
        message,
    );
}
