import { execFile as execFileCallback } from "node:child_process";
import { isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";

import type { ProjectRemoteSource } from "../protocol/index.js";
import { gitIdentityEnvironment } from "../profiles/gitIdentityEnvironment.js";
import { redactGitAuthenticationText, type GitAuthentication } from "./GitCredentialBroker.js";

const execFile = promisify(execFileCallback);

const GIT_CLONE_OUTPUT_LIMIT = 1024 * 1024;
const GIT_CLONE_TIMEOUT_MS = 60 * 60 * 1_000;
const GITHUB_REPOSITORY_SEGMENT = /^[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,99})$/u;
const STRIPPED_GIT_ENVIRONMENT = [
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_ASKPASS",
    "GIT_CONFIG",
    "GIT_CONFIG_GLOBAL",
    "GIT_CONFIG_SYSTEM",
    "GIT_DIR",
    "GIT_EXEC_PATH",
    "GIT_OBJECT_DIRECTORY",
    "GIT_PROXY_COMMAND",
    "GIT_SSH",
    "GIT_SSH_COMMAND",
    "GIT_TEMPLATE_DIR",
    "GIT_WORK_TREE",
];

export interface GitCloneExecFileOptions {
    encoding: "utf8";
    env: NodeJS.ProcessEnv;
    maxBuffer: number;
    timeout: number;
}

export type GitCloneExecFile = (
    file: string,
    args: readonly string[],
    options: GitCloneExecFileOptions,
) => Promise<{ stderr: string; stdout: string }>;

export interface CloneRemoteRepositoryOptions {
    destination: string;
    execFile?: GitCloneExecFile;
    gitAuthentication?: GitAuthentication;
    gitIdentity: { email: string; name: string };
    source: ProjectRemoteSource;
}

/**
 * Clones one remote repository into an exact destination.
 *
 * GitHub authentication is a process-only URL rewrite to Rig's in-memory
 * credential broker. The token is never placed in the remote URL, Git
 * arguments, process environment, or persisted Git config.
 */
export async function cloneRemoteRepository(options: CloneRemoteRepositoryOptions): Promise<void> {
    const destination = validateDestination(options.destination);
    const remote = remoteUrlForSource(options.source);
    const environment = {
        ...cloneEnvironment(options.gitAuthentication),
        ...gitIdentityEnvironment(options.gitIdentity),
    };
    const execute = options.execFile ?? runExecFile;

    try {
        await execute("git", ["clone", "--", remote, destination], {
            encoding: "utf8",
            env: environment,
            maxBuffer: GIT_CLONE_OUTPUT_LIMIT,
            // A clone can legitimately take much longer than a local Git operation,
            // but it must not keep daemon shutdown waiting forever.
            timeout: GIT_CLONE_TIMEOUT_MS,
        });
    } catch (error) {
        throwRedactedGitError(error, options.gitAuthentication?.environment);
    }
}

function throwRedactedGitError(
    error: unknown,
    environment: Readonly<Record<string, string>> | undefined,
): never {
    if (environment === undefined || !(error instanceof Error)) throw error;
    const message = redactGitAuthenticationText(error.message, environment);
    if (message === error.message) throw error;
    throw new Error(message, { cause: error });
}

export function remoteUrlForSource(source: ProjectRemoteSource): string {
    if (source.kind === "github") {
        const repository = validateGitHubRepository(source.repository);
        return `https://github.com/${repository}.git`;
    }
    return validateGitRemoteUrl(source.url);
}

function cloneEnvironment(authentication: GitAuthentication | undefined): NodeJS.ProcessEnv {
    const environment: NodeJS.ProcessEnv = { ...process.env };
    for (const name of STRIPPED_GIT_ENVIRONMENT) delete environment[name];
    for (const name of Object.keys(environment)) {
        if (/^GIT_CONFIG_(?:KEY|VALUE)_\d+$/u.test(name)) delete environment[name];
    }
    // Ignore user and system Git configuration so an unattended clone cannot
    // invoke a credential helper, URL rewrite, proxy command, or template hook.
    environment.GIT_CONFIG_GLOBAL = "/dev/null";
    environment.GIT_CONFIG_NOSYSTEM = "1";
    environment.GIT_CONFIG_COUNT = "1";
    environment.GIT_CONFIG_KEY_0 = "credential.helper";
    environment.GIT_CONFIG_VALUE_0 = "";
    if (authentication !== undefined) {
        Object.assign(environment, authentication.environment);
    }
    environment.GIT_TERMINAL_PROMPT = "0";
    return environment;
}

function validateDestination(destination: string): string {
    if (
        destination.length === 0 ||
        destination.includes("\0") ||
        !isAbsolute(destination) ||
        resolve(destination) !== destination
    ) {
        throw new Error("The clone destination must be an absolute, normalized path.");
    }
    return destination;
}

function validateGitHubRepository(repository: string): string {
    const parts = repository.split("/");
    if (
        parts.length !== 2 ||
        parts.some((part) => !GITHUB_REPOSITORY_SEGMENT.test(part) || part === "." || part === "..")
    ) {
        throw new Error("The GitHub repository must use the form owner/repository.");
    }
    return repository;
}

/**
 * Keeps Git on a network protocol Git itself handles, instead of accepting
 * local paths, `file:` URLs, `ext::` commands, or custom remote helpers.
 */
function validateGitRemoteUrl(remote: string): string {
    if (remote.length === 0 || remote.includes("\0") || remote !== remote.trim()) {
        throw new Error("The Git remote URL is invalid.");
    }
    let url: URL;
    try {
        url = new URL(remote);
    } catch {
        throw new Error("The Git remote URL is invalid.");
    }
    if (
        url.protocol !== "https:" ||
        url.hostname.length === 0 ||
        url.username.length > 0 ||
        url.password.length > 0
    ) {
        throw new Error("The Git remote URL must be an HTTPS URL without credentials.");
    }
    return url.toString();
}

async function runExecFile(
    file: string,
    args: readonly string[],
    options: GitCloneExecFileOptions,
): Promise<{ stderr: string; stdout: string }> {
    return await execFile(file, args, options);
}
