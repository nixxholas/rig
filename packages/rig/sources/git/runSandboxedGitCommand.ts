import { runScanGit } from "./runScanGit.js";

/**
 * Runs one read-only Git command through Rig's sandbox and returns its trimmed output.
 *
 * Background probes run in the daemon rather than inside a session, so they go through the same
 * sandboxed reader that live scans do, for the same reason: a repository must not be able to make
 * an unattended read execute a helper program.
 */
export async function runSandboxedGitCommand(
    cwd: string,
    args: readonly string[],
): Promise<string> {
    const result = await runScanGit({ args, cwd });
    return result.stdout.trim();
}
