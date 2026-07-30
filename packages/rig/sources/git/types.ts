/**
 * Runs one Git command in a working directory and returns its trimmed standard output, throwing
 * when Git exits non-zero.
 *
 * Every Git operation in this module takes a runner rather than executing Git itself, so the caller
 * decides which execution surface applies: the direct binary for a foreground action the user
 * asked for, the sandboxed reader for unattended background work, or a stub in a test.
 */
export type GitCommandRunner = (cwd: string, args: readonly string[]) => Promise<string>;
