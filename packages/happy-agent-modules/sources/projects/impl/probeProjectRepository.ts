import { computePermissions } from "@slopus/happy-agent-compute";
import type { Context } from "@steve.kite/stdlib";

import type { HostCompute } from "../../compute/ComputeModule.js";
import type { ProjectGitFacts, ProjectPresence, ProjectWorktreeSupport } from "../Project.js";
import { readProjectGit } from "./runProjectGit.js";

/** What one look at a project folder found. */
export interface ProjectRepositoryProbe {
    readonly facts?: ProjectGitFacts;
    readonly presence: ProjectPresence;
    readonly worktreeSupport: ProjectWorktreeSupport;
    readonly worktreeUnsupportedReason?: string;
}

/**
 * Looks at one project folder and reports what is true of it right now: whether it is still
 * there, whether a workspace can be cut from it, and where its Git state stands.
 *
 * Every unsupported answer carries a reason someone can read, because "you cannot make a
 * workspace here" is only useful alongside why.
 */
export async function probeProjectRepository(
    ctx: Context,
    compute: HostCompute,
    options: { readonly isHome?: boolean; readonly path: string; readonly signal?: AbortSignal },
): Promise<ProjectRepositoryProbe> {
    const permissions = computePermissions("read_only");
    const signal = options.signal === undefined ? {} : { signal: options.signal };
    if (!(await isDirectory(compute, options.path))) {
        return {
            presence: "missing",
            worktreeSupport: "unsupported",
            worktreeUnsupportedReason: "This folder no longer exists.",
        };
    }
    if (options.isHome === true) {
        return {
            presence: "present",
            worktreeSupport: "unsupported",
            worktreeUnsupportedReason: "Worktrees cannot be created from your home folder.",
        };
    }
    const read = async (args: readonly string[]): Promise<string | undefined> =>
        await readProjectGit(ctx, compute, options.path, args, { permissions, ...signal });

    const topLevel = await read(["rev-parse", "--show-toplevel"]);
    if (topLevel === undefined) {
        const bare = (await read(["rev-parse", "--is-bare-repository"])) === "true";
        return {
            presence: "present",
            worktreeSupport: "unsupported",
            worktreeUnsupportedReason: bare
                ? "This is a bare Git repository."
                : "This folder is not a Git repository.",
        };
    }
    if (
        (await realPath(compute, topLevel)) !== (await realPath(compute, options.path))
    ) {
        return {
            presence: "present",
            worktreeSupport: "unsupported",
            worktreeUnsupportedReason: "This folder is inside a Git repository but is not its root.",
        };
    }
    const facts = await readProjectGitFacts(read);
    // A repository with no commits has nothing to branch from yet.
    const unsupportedReason = facts.head === undefined ? "This repository has no commits yet." : undefined;
    return {
        facts,
        presence: "present",
        worktreeSupport: unsupportedReason === undefined ? "supported" : "unsupported",
        ...(unsupportedReason === undefined ? {} : { worktreeUnsupportedReason: unsupportedReason }),
    };
}

/** Branch, head, upstream and divergence, as Git reports them for one folder. */
export async function readProjectGitFacts(
    read: (args: readonly string[]) => Promise<string | undefined>,
): Promise<ProjectGitFacts> {
    const head = await read(["rev-parse", "--verify", "HEAD"]);
    const branch = await read(["symbolic-ref", "--quiet", "--short", "HEAD"]);
    const upstream =
        branch === undefined
            ? undefined
            : await read(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
    const divergence =
        upstream === undefined
            ? undefined
            : await read(["rev-list", "--left-right", "--count", `${upstream}...HEAD`]);
    const [behind = 0, ahead = 0] = (divergence ?? "")
        .split(/\s+/u)
        .filter(Boolean)
        .map((value) => Number.parseInt(value, 10))
        .map((value) => (Number.isFinite(value) ? value : 0));
    return {
        ahead,
        behind,
        ...(branch === undefined ? {} : { branch }),
        detached: head !== undefined && branch === undefined,
        ...(head === undefined ? {} : { head }),
        ...(upstream === undefined ? {} : { upstream }),
    };
}

async function isDirectory(compute: HostCompute, path: string): Promise<boolean> {
    try {
        return (await compute.fs.stat(computePermissions("read_only"), path)).isDirectory;
    } catch {
        return false;
    }
}

async function realPath(compute: HostCompute, path: string): Promise<string> {
    try {
        return await compute.fs.realpath(computePermissions("read_only"), path);
    } catch {
        return path;
    }
}
