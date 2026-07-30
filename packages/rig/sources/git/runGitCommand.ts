import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

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
 */
export async function runGitCommand(cwd: string, args: readonly string[]): Promise<string> {
    const result = await execFile("git", ["-C", cwd, ...args], {
        encoding: "utf8",
        maxBuffer: GIT_OUTPUT_LIMIT,
        timeout: GIT_TIMEOUT_MS,
    });
    return result.stdout.trim();
}
