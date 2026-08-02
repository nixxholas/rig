import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

import { createSandboxedCommand } from "../agent/context/createSandboxedCommand.js";
import { resolveGitExecutable } from "./resolveGitExecutable.js";

const execFile = promisify(execFileCallback);

const SCAN_TIMEOUT_MS = 10_000;
const SCAN_OUTPUT_LIMIT = 16 * 1024 * 1024;

/**
 * Git environment variables that can redirect a read or make it execute a helper. They are removed
 * rather than overridden so an inherited value cannot survive in a different spelling.
 */
const STRIPPED_ENVIRONMENT = [
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_ASKPASS",
    "GIT_CONFIG",
    "GIT_CONFIG_COUNT",
    "GIT_CONFIG_GLOBAL",
    "GIT_CONFIG_SYSTEM",
    "GIT_DIR",
    "GIT_EDITOR",
    "GIT_EXTERNAL_DIFF",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_WORK_TREE",
];

/**
 * Configuration overrides that stop Git from spawning repository-configured helper programs.
 *
 * Measured against a repository carrying a `core.fsmonitor` payload: `status` executed it once,
 * and a plain `diff` executed textconv and `diff.external` three times. The scan diff
 * (`--raw --numstat`) executes nothing on its own, but the flags are applied uniformly so no future
 * caller has to remember which subcommand is exposed.
 */
const SAFE_CONFIGURATION = [
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "diff.external=",
    "-c",
    "credential.helper=",
];

export interface ScanGitResult {
    stdout: string;
    /** The same output as raw bytes, for a caller whose content is a file rather than text. */
    stdoutBytes: Buffer;
    /** True when Git produced more output than the scan is willing to hold. */
    truncated: boolean;
}

/**
 * Runs one read-only Git command inside Rig's own sandbox.
 *
 * Every execution surface in Rig goes through the same sandbox, and a background Git reader is an
 * execution surface: it runs in the unsandboxed daemon, outside any session's permission review,
 * against a `.git` directory the agent is allowed to write. `read_only` denies writes and the
 * network outright, so a helper Git spawns inherits a cage rather than the daemon's privileges.
 */
export async function runScanGit(options: {
    args: readonly string[];
    cwd: string;
    /** Output ceiling for this scan. Defaults to the standard scan limit. */
    maximumBytes?: number;
    signal?: AbortSignal;
}): Promise<ScanGitResult> {
    const git = await resolveGitExecutable();
    const sandboxed = await createSandboxedCommand({
        argv: [
            git,
            "-C",
            options.cwd,
            "--no-optional-locks",
            ...SAFE_CONFIGURATION,
            ...options.args,
        ],
        command: "",
        cwd: options.cwd,
        mode: "read_only",
        shell: "/bin/sh",
    });
    try {
        const result = await execFile(sandboxed.command, [...(sandboxed.args ?? [])], {
            cwd: options.cwd,
            encoding: "buffer",
            env: scanEnvironment(),
            maxBuffer: options.maximumBytes ?? SCAN_OUTPUT_LIMIT,
            timeout: SCAN_TIMEOUT_MS,
            ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
        return {
            stdout: result.stdout.toString("utf8"),
            stdoutBytes: result.stdout,
            truncated: false,
        };
    } catch (error) {
        // Exceeding maxBuffer is a bound working as intended, not a repository problem: report the
        // partial output and let the caller mark its counts inexact.
        if (isMaxBufferError(error)) {
            const stdout = (error as { stdout?: Buffer }).stdout ?? Buffer.alloc(0);
            return { stdout: stdout.toString("utf8"), stdoutBytes: stdout, truncated: true };
        }
        throw error;
    }
}

function scanEnvironment(): NodeJS.ProcessEnv {
    const environment: NodeJS.ProcessEnv = { ...process.env };
    for (const name of STRIPPED_ENVIRONMENT) delete environment[name];
    environment.GIT_TERMINAL_PROMPT = "0";
    environment.GIT_OPTIONAL_LOCKS = "0";
    // Promisor repositories otherwise fetch missing objects mid-scan, turning a local read into a
    // network request from a background task.
    environment.GIT_NO_LAZY_FETCH = "1";
    environment.GIT_PAGER = "cat";
    environment.LC_ALL = "C";
    return environment;
}

function isMaxBufferError(error: unknown): boolean {
    return (
        typeof error === "object" &&
        error !== null &&
        (error as { code?: unknown }).code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
    );
}
