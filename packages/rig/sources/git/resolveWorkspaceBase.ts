import { resolveGitCommit } from "./resolveGitCommit.js";
import type { GitCommandRunner } from "./types.js";

export interface WorkspaceBase {
    /** Immutable commit the workspace branch starts from. */
    commit: string;
    /** Reference the commit was read from, recorded so a retry resolves the same thing. */
    ref: string;
}

/**
 * Chooses the commit a new workspace branch starts from.
 *
 * Work starts from the trunk as the remote has it, not from whatever the project folder has been
 * left on, so an unspecified base means `origin/<trunk>`. The remote is fetched first whatever the
 * base turns out to be, so that a reference naming the remote is read at its current position.
 * Fetching writes only remote-tracking refs and objects into the shared object store; the project's
 * own working tree, HEAD, and local branches are never touched. A repository with no `origin`, or
 * one whose remote cannot be reached, falls back to what it already has, because being offline
 * should not stop a workspace from being created.
 *
 * An explicitly requested reference is used exactly as given: the caller has already said what to
 * fork, and quietly substituting the trunk would fork something other than what was asked for.
 */
export async function resolveWorkspaceBase(options: {
    /** Branch the project treats as its trunk, absent when the repository has no branches. */
    defaultBranch?: string;
    git: GitCommandRunner;
    projectPath: string;
    /** Explicit base chosen by the caller; the trunk is used when it is absent. */
    requestedRef?: string;
}): Promise<WorkspaceBase> {
    // Only a base that names the remote is worth waiting on the network for. Forking a commit, a
    // tag, or a local branch is a purely local question, and a fetch there would put an interactive
    // request behind a network round trip for nothing.
    const needsRemote =
        options.requestedRef === undefined || options.requestedRef.startsWith("origin/");
    if (needsRemote && (await hasOrigin(options.git, options.projectPath))) {
        try {
            await options.git(options.projectPath, ["fetch", "origin"]);
        } catch {
            // An unreachable remote leaves the last fetched state in place rather than failing.
        }
    }
    if (options.requestedRef !== undefined) {
        // Git reports an unknown reference by failing, so the caller's mistake has to be turned
        // back into a sentence about what they asked for rather than a raw command failure.
        const commit = await tryResolve(options.git, options.projectPath, options.requestedRef);
        if (commit === undefined) {
            throw new Error(
                `The workspace base "${options.requestedRef}" did not resolve to a commit in this repository.`,
            );
        }
        return { commit, ref: options.requestedRef };
    }

    const branch = options.defaultBranch;
    if (branch === undefined) {
        throw new Error(
            "This project has no branch to start a workspace from. Name an explicit base to fork.",
        );
    }
    const remoteRef = `refs/remotes/origin/${branch}`;
    const remoteCommit = await tryResolve(options.git, options.projectPath, remoteRef);
    if (remoteCommit !== undefined) return { commit: remoteCommit, ref: `origin/${branch}` };
    const localCommit = await tryResolve(options.git, options.projectPath, `refs/heads/${branch}`);
    if (localCommit === undefined) {
        throw new Error(
            `This project's branch "${branch}" has no commit to start a workspace from. Name an explicit base to fork.`,
        );
    }
    return { commit: localCommit, ref: branch };
}

async function hasOrigin(git: GitCommandRunner, path: string): Promise<boolean> {
    try {
        await git(path, ["remote", "get-url", "origin"]);
        return true;
    } catch {
        return false;
    }
}

async function tryResolve(
    git: GitCommandRunner,
    path: string,
    ref: string,
): Promise<string | undefined> {
    try {
        return await resolveGitCommit(git, path, ref);
    } catch {
        return undefined;
    }
}
