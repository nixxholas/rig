import { statSync } from "node:fs";

import type {
    GitRepositoryFacts,
    ProjectPresence,
    ProjectWorktreeSupport,
} from "../protocol/index.js";
import { normalizeProjectCwd } from "./normalizeProjectCwd.js";

export type GitProbeRunner = (cwd: string, args: readonly string[]) => Promise<string>;

export interface GitRepositoryProbe {
    facts?: GitRepositoryFacts;
    presence: ProjectPresence;
    worktreeSupport: ProjectWorktreeSupport;
    /** Human-readable explanation, present only when worktreeSupport is "unsupported". */
    worktreeSupportReason?: string;
}

/**
 * Reads the slow-moving Git facts of one directory: does it still exist, can a managed workspace be
 * created from it, and which branch and commit is it on. Every Git failure is treated as "this is
 * not a usable repository" rather than an error, because a probe is enrichment and must never fail
 * the caller.
 */
export async function probeGitRepository(options: {
    git: GitProbeRunner;
    /** The home project can never host a worktree, whatever Git reports about it. */
    isHome?: boolean;
    path: string;
}): Promise<GitRepositoryProbe> {
    if (!isDirectory(options.path)) {
        return {
            presence: "missing",
            worktreeSupport: "unsupported",
            worktreeSupportReason: "This folder no longer exists.",
        };
    }
    if (options.isHome === true) {
        return {
            presence: "present",
            worktreeSupport: "unsupported",
            worktreeSupportReason: "Worktrees cannot be created from your home folder.",
        };
    }

    const run = async (args: readonly string[]): Promise<string | undefined> => {
        try {
            return await options.git(options.path, args);
        } catch {
            return undefined;
        }
    };

    const topLevel = await run(["rev-parse", "--show-toplevel"]);
    if (topLevel === undefined) {
        // `--show-toplevel` fails in a bare repository because there is no work tree, so the bare
        // check has to happen here rather than after it.
        const bare = (await run(["rev-parse", "--is-bare-repository"])) === "true";
        return {
            presence: "present",
            worktreeSupport: "unsupported",
            worktreeSupportReason: bare
                ? "This is a bare Git repository."
                : "This folder is not a Git repository.",
        };
    }
    if (normalizeProjectCwd(topLevel) !== normalizeProjectCwd(options.path)) {
        return {
            presence: "present",
            worktreeSupport: "unsupported",
            worktreeSupportReason: "This folder is inside a Git repository but is not its root.",
        };
    }

    const facts = await readFacts(run);
    const unsupportedReason =
        facts.head === undefined ? "This repository has no commits yet." : undefined;
    return {
        facts,
        presence: "present",
        worktreeSupport: unsupportedReason === undefined ? "supported" : "unsupported",
        ...(unsupportedReason === undefined ? {} : { worktreeSupportReason: unsupportedReason }),
    };
}

async function readFacts(
    run: (args: readonly string[]) => Promise<string | undefined>,
): Promise<GitRepositoryFacts> {
    const head = await run(["rev-parse", "--verify", "HEAD"]);
    const branch = await run(["symbolic-ref", "--quiet", "--short", "HEAD"]);
    const upstream =
        branch === undefined
            ? undefined
            : await run(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
    const divergence =
        upstream === undefined
            ? undefined
            : await run(["rev-list", "--left-right", "--count", `${upstream}...HEAD`]);
    const [behind = 0, ahead = 0] = (divergence ?? "")
        .split(/\s+/u)
        .filter(Boolean)
        .map((value) => Number.parseInt(value, 10))
        .map((value) => (Number.isFinite(value) ? value : 0));
    return {
        ahead,
        behind,
        ...(branch === undefined ? {} : { branch }),
        // An unborn HEAD is neither detached nor on a resolvable commit, so it stays attached.
        detached: head !== undefined && branch === undefined,
        ...(head === undefined ? {} : { head }),
        ...(upstream === undefined ? {} : { upstream }),
    };
}

function isDirectory(path: string): boolean {
    try {
        return statSync(path).isDirectory();
    } catch {
        return false;
    }
}
