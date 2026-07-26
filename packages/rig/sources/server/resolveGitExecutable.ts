import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

let cached: Promise<string> | undefined;

/**
 * Resolves the real Git binary once per daemon.
 *
 * On macOS `/usr/bin/git` is the `xcrun` shim, which writes a cache file into TMPDIR on every
 * invocation. Inside a sandbox that write can fail, and the shim then falls back to a path
 * resolution costing hundreds of milliseconds per call — measured at 409 ms against 11 ms for the
 * resolved binary. Background scans run often enough that this dominates everything else.
 */
export function resolveGitExecutable(): Promise<string> {
    cached ??= resolve();
    return cached;
}

/** Test seam: forget the cached path so a test can observe resolution again. */
export function resetResolvedGitExecutable(): void {
    cached = undefined;
}

async function resolve(): Promise<string> {
    if (process.platform === "darwin") {
        try {
            const result = await execFile("xcrun", ["--find", "git"], {
                encoding: "utf8",
                timeout: 5_000,
            });
            const path = result.stdout.trim();
            if (path.length > 0) return path;
        } catch {
            // Xcode command line tools are not installed; PATH lookup is the normal case.
        }
    }
    return "git";
}
