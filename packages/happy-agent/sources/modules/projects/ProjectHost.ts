import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, realpath, stat } from "node:fs/promises";
import { promisify } from "node:util";

import type { Context } from "@steve.kite/stdlib";

const execFile = promisify(execFileCallback);

export interface GitCommandResult {
    readonly code: number;
    readonly stderr: string;
    readonly stdout: string;
}

export interface GitCommandRunner {
    run(
        cwd: string,
        args: readonly string[],
        options?: { readonly signal?: AbortSignal; readonly maxOutputBytes?: number },
    ): Promise<GitCommandResult>;
}

export interface ProjectWorkspaceHost {
    readonly git: GitCommandRunner;
    readonly protectedPaths?: readonly string[];
    readonly createWorkspace?: (
        ctx: Context,
        input: {
            readonly branch: string;
            readonly path: string;
            readonly projectPath: string;
            readonly baseRef?: string;
        },
    ) => Promise<void>;
    readonly cloneRemote?: (
        ctx: Context,
        input: {
            readonly destination: string;
            readonly source: {
                readonly kind: "github" | "git";
                readonly repository?: string;
                readonly url?: string;
            };
        },
    ) => Promise<void>;
    readonly removeWorkspace?: (ctx: Context, path: string) => Promise<void>;
    readonly resolveGitSecret?: (kind: "github") => string | undefined;
    readonly asset?: (
        hash: string,
    ) => Promise<{ readonly body: Buffer; readonly mediaType: string } | undefined>;
}

export function createLocalProjectWorkspaceHost(): ProjectWorkspaceHost {
    return {
        git: {
            async run(cwd, args, options = {}) {
                const maxBuffer = options.maxOutputBytes ?? 4 * 1024 * 1024;
                try {
                    const result = await execFile("git", [...args], {
                        cwd,
                        maxBuffer,
                        signal: options.signal,
                    });
                    return {
                        code: 0,
                        stderr: result.stderr,
                        stdout: result.stdout,
                    };
                } catch (error) {
                    const candidate = error as {
                        readonly code?: number | string;
                        readonly stderr?: string;
                        readonly stdout?: string;
                    };
                    return {
                        code: typeof candidate.code === "number" ? candidate.code : 1,
                        stderr: candidate.stderr ?? (error instanceof Error ? error.message : ""),
                        stdout: candidate.stdout ?? "",
                    };
                }
            },
        },
        async createWorkspace(_ctx, input) {
            await mkdir(input.path, { recursive: true, mode: 0o755 });
        },
    };
}

export async function canonicalProjectDirectory(path: string): Promise<string> {
    const canonical = await realpath(path);
    const information = await stat(canonical);
    if (!information.isDirectory()) {
        throw new Error("The project path must be a directory.");
    }
    await access(canonical);
    return canonical;
}

export async function assertGitTopLevel(host: ProjectWorkspaceHost, path: string): Promise<string> {
    const result = await host.git.run(path, ["rev-parse", "--show-toplevel"], {
        maxOutputBytes: 16 * 1024,
    });
    if (result.code !== 0) {
        throw new Error("The project folder is not a Git repository.");
    }
    const topLevel = await realpath(result.stdout.trim());
    if (topLevel !== path) {
        throw new Error("The project path must be the top level of a Git repository.");
    }
    return topLevel;
}

export function createContentToken(): string {
    return randomUUID();
}
