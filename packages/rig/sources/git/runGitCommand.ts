import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

import { redactGitAuthenticationText } from "./GitCredentialBroker.js";

const execFile = promisify(execFileCallback);

const GIT_TIMEOUT_MS = 5_000;
const GIT_OUTPUT_LIMIT = 1024 * 1024;

/**
 * Runs one Git command directly against the repository and returns its trimmed output.
 *
 * This is the foreground execution surface: it backs actions a user asked for, such as creating or
 * removing a managed worktree, where Git has to be able to write. Unattended background reads use
 * `runSandboxedGitCommand` instead. Both the timeout and the output ceiling are deliberate so a
 * repository that hangs or floods cannot stall the daemon.
 *
 * A command that talks to a remote runs without a deadline. How long a fetch takes belongs to the
 * repository and the network, not to a number chosen here, and any limit small enough to protect
 * the daemon is small enough to fail an ordinary clone of a large repository — silently, since the
 * caller tolerates a failed fetch. Terminal prompting is disabled for every command instead, so the
 * one thing that would genuinely wait forever, a repository asking for credentials, fails at once.
 */
export async function runGitCommand(cwd: string, args: readonly string[]): Promise<string> {
    return await runGitCommandWithEnvironment(cwd, args);
}

export async function runGitCommandWithEnvironment(
    cwd: string,
    args: readonly string[],
    environment: Readonly<Record<string, string>> = {},
): Promise<string> {
    try {
        const result = await execFile("git", ["-C", cwd, ...args], {
            encoding: "utf8",
            env: { ...process.env, ...environment, GIT_TERMINAL_PROMPT: "0" },
            maxBuffer: GIT_OUTPUT_LIMIT,
            timeout: usesNetwork(args) ? 0 : GIT_TIMEOUT_MS,
        });
        return result.stdout.trim();
    } catch (error) {
        if (!(error instanceof Error)) throw error;
        const message = redactGitAuthenticationText(error.message, environment);
        if (message === error.message) throw error;
        throw new Error(message, { cause: error });
    }
}

function usesNetwork(args: readonly string[]): boolean {
    return args[0] === "fetch";
}
