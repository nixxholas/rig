import { resolve } from "node:path";

import { normalizeProjectCwd } from "../utils/normalizeProjectCwd.js";
import type { GitCommandRunner } from "./types.js";

/**
 * Reads the Git control directory shared by a repository and every worktree cut from it.
 *
 * This is the identity Rig uses to decide whether a repository still owns a managed worktree, so
 * the result is resolved against the directory it was read from and normalized: Git may answer with
 * a relative path, and two spellings of the same directory have to compare equal.
 */
export async function readGitCommonDir(git: GitCommandRunner, path: string): Promise<string> {
    const reported = await git(path, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    return normalizeProjectCwd(resolve(path, reported));
}
