import { execFile as execFileCallback, type ExecFileException } from "node:child_process";
import { promisify } from "node:util";

import { forever } from "../concurrency/index.js";
import type { SpecialSecretRegistration } from "./types.js";

const execFile = promisify(execFileCallback);

export const GITHUB_SECRET_REFRESH_INTERVAL_MS = 60 * 60 * 1_000;

export type GitHubCliTokenResult =
    | { status: "available"; token: string }
    | { status: "not_authenticated" }
    | { status: "unavailable" };

export interface GitHubSecretSyncOptions {
    readToken?: () => Promise<GitHubCliTokenResult>;
    refreshIntervalMs?: number;
    register: (secret: SpecialSecretRegistration) => void;
    unregister: () => void;
}

export class GitHubSecretSync {
    readonly #readToken: () => Promise<GitHubCliTokenResult>;
    readonly #refreshIntervalMs: number;
    readonly #register: (secret: SpecialSecretRegistration) => void;
    readonly #unregister: () => void;

    constructor(options: GitHubSecretSyncOptions) {
        this.#readToken = options.readToken ?? readGitHubCliToken;
        this.#refreshIntervalMs = options.refreshIntervalMs ?? GITHUB_SECRET_REFRESH_INTERVAL_MS;
        this.#register = options.register;
        this.#unregister = options.unregister;
    }

    async refresh(): Promise<void> {
        const result = await this.#readToken();
        if (result.status === "available") {
            this.#register({ kind: "github", token: result.token });
            return;
        }
        if (result.status === "not_authenticated") this.#unregister();
        // A missing or temporarily unusable gh executable must not erase the last known-good token.
    }

    run(signal: AbortSignal): Promise<void> {
        return forever(
            {
                delay: this.#refreshIntervalMs,
                delayFirst: true,
                name: "GitHub credential refresh",
                signal,
            },
            () => this.refresh(),
        );
    }
}

export async function readGitHubCliToken(): Promise<GitHubCliTokenResult> {
    try {
        const result = await execFile("gh", ["auth", "token", "--hostname", "github.com"], {
            encoding: "utf8",
            maxBuffer: 128 * 1024,
            timeout: 10_000,
        });
        const token = result.stdout.trim();
        return token.length === 0
            ? { status: "not_authenticated" }
            : { status: "available", token };
    } catch (error) {
        return githubCliFailureStatus(error);
    }
}

function githubCliFailureStatus(error: unknown): GitHubCliTokenResult {
    const failure = error as ExecFileException & { stderr?: unknown };
    if (failure.code === "ENOENT" || failure.killed === true) return { status: "unavailable" };
    const stderr = typeof failure.stderr === "string" ? failure.stderr : "";
    return /no oauth token found|not logged into any hosts/iu.test(stderr)
        ? { status: "not_authenticated" }
        : { status: "unavailable" };
}
