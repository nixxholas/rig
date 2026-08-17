import { computePermissions } from "@slopus/happy-agent-compute";
import type { Context } from "@steve.kite/stdlib";

import type { ComputePermissions } from "../../compute/Compute.js";
import type { HostCompute } from "../../compute/ComputeModule.js";

/** How one Git command ended. A probe reads a failure rather than losing Git's own diagnosis. */
export interface ProjectGitResult {
    readonly code: number;
    readonly stderr: string;
    readonly stdout: string;
}

export interface ProjectGitOptions {
    readonly maxOutputBytes?: number;
    /** The boundary this one command runs inside. Reading defaults to read-only and no network. */
    readonly permissions?: ComputePermissions;
    readonly signal?: AbortSignal;
    readonly timeoutMs?: number;
}

const DEFAULT_GIT_TIMEOUT_MS = 30_000;
const DEFAULT_GIT_OUTPUT_BYTES = 1_048_576;

/**
 * Runs one Git command on the machine the agent actually works on.
 *
 * A compute shell takes a command line rather than an argument vector, so every argument is
 * single-quoted here: a branch, a path, or a remote URL is data, and nothing in it may become
 * shell syntax. Git is also told never to ask a human anything, because this runs in the
 * background where there is nobody to answer.
 */
export async function runProjectGit(
    _ctx: Context,
    compute: HostCompute,
    cwd: string,
    args: readonly string[],
    options: ProjectGitOptions = {},
): Promise<ProjectGitResult> {
    const command = [
        "GIT_TERMINAL_PROMPT=0",
        "GIT_OPTIONAL_LOCKS=0",
        "GIT_ASKPASS=",
        "git",
        ...args.map(shellQuote),
    ].join(" ");
    const result = await compute.shell.run({
        command,
        cwd,
        maxOutputBytes: options.maxOutputBytes ?? DEFAULT_GIT_OUTPUT_BYTES,
        permissions: options.permissions ?? computePermissions("read_only"),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        timeoutMs: options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS,
    });
    // A command that reached its timeout is backgrounded rather than killed, so it never returns
    // an exit code. To a probe that is simply a failure with a reason.
    if (result.timedOut) {
        return { code: 124, stderr: "Git did not finish in time.", stdout: result.stdout };
    }
    return { code: result.exitCode ?? 1, stderr: result.stderr, stdout: result.stdout };
}

/** The trimmed output of a Git command that had to succeed. */
export async function runProjectGitOrThrow(
    ctx: Context,
    compute: HostCompute,
    cwd: string,
    args: readonly string[],
    options?: ProjectGitOptions,
): Promise<string> {
    const result = await runProjectGit(ctx, compute, cwd, args, options);
    if (result.code === 0) return result.stdout.trim();
    throw new Error(result.stderr.trim() || `Git exited with status ${String(result.code)}.`);
}

/**
 * The trimmed output of a Git command whose failure is an ordinary answer — a folder that is not
 * a repository, a branch that does not exist, a remote nobody configured.
 */
export async function readProjectGit(
    ctx: Context,
    compute: HostCompute,
    cwd: string,
    args: readonly string[],
    options?: ProjectGitOptions,
): Promise<string | undefined> {
    try {
        const output = await runProjectGitOrThrow(ctx, compute, cwd, args, options);
        return output.length === 0 ? undefined : output;
    } catch {
        return undefined;
    }
}

function shellQuote(value: string): string {
    return `'${value.replaceAll("'", `'\\''`)}'`;
}
