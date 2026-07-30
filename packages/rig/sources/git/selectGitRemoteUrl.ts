import { remoteProjectName } from "./remoteProjectName.js";
import type { GitCommandRunner } from "./types.js";

/**
 * Picks the remote that best describes what a repository is.
 *
 * The order is deliberate and stable: the remote the current branch tracks first, because that is
 * where the user's work actually goes; then `origin`, the near-universal convention; then the
 * remaining remotes in Git's own order, taking the first that names a repository rather than a
 * local path. Every step tolerates failure, since a repository with no remote at all is normal and
 * only means Rig keeps the folder name.
 */
export async function selectGitRemoteUrl(
    git: GitCommandRunner,
    cwd: string,
): Promise<string | undefined> {
    try {
        const branch = await git(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
        const trackedRemote = await git(cwd, ["config", "--get", `branch.${branch}.remote`]);
        if (trackedRemote !== ".") {
            return await git(cwd, ["config", "--get", `remote.${trackedRemote}.url`]);
        }
    } catch {
        // Fall through to origin and then stable remote order.
    }
    try {
        return await git(cwd, ["config", "--get", "remote.origin.url"]);
    } catch {
        // Fall through.
    }
    try {
        const remotes = (await git(cwd, ["remote"]))
            .split(/\r?\n/gu)
            .map((value) => value.trim())
            .filter(Boolean);
        for (const remote of remotes) {
            const url = await git(cwd, ["config", "--get", `remote.${remote}.url`]);
            if (remoteProjectName(url) !== undefined) return url;
        }
    } catch {
        // No usable remote.
    }
    return undefined;
}
