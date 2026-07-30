import { normalizeProjectCwd } from "../utils/normalizeProjectCwd.js";
import type { GitCommandRunner } from "./types.js";

/**
 * Reads the root of the working tree containing a directory, normalized so it can be compared with
 * a path Rig already holds. Throws when the directory is not inside a Git working tree.
 */
export async function readGitTopLevel(git: GitCommandRunner, path: string): Promise<string> {
    return normalizeProjectCwd(await git(path, ["rev-parse", "--show-toplevel"]));
}
