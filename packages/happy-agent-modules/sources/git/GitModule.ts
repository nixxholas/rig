import { randomUUID } from "node:crypto";

import { Type, type Static } from "@sinclair/typebox";

import type { GitCommandRunner } from "./GitCommandRunner.js";
import type { GitLiveSnapshot } from "./GitStateTracker.js";
import { probeGitRepository } from "./probeGitRepository.js";
import { scanGitRepository } from "./scanGitRepository.js";
import {
    gitCommandRunnerFromScanGitRunner,
    scanGitRunnerFromCommandRunner,
    type ScanGitRunner,
} from "./runScanGit.js";
import type { GitChangeSnapshot, GitFileChange, GitRepositoryFacts } from "./types.js";

export const gitEntitySchema = Type.Object(
    {
        projectId: Type.String({ minLength: 1, maxLength: 128 }),
        workspaceId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    },
    { additionalProperties: false },
);
export const gitWatchSchema = Type.Object(
    {
        // Watching nothing is a real state, not a mistake: a client whose window shows no folder
        // yet still polls, and it is told about no folders rather than refused.
        entities: Type.Array(gitEntitySchema, { maxItems: 256 }),
    },
    { additionalProperties: false },
);

export type GitEntity = Static<typeof gitEntitySchema>;
export type GitWatchInput = Static<typeof gitWatchSchema>;
export type GitChangedFile = GitFileChange;
export type { GitChangeSnapshot, GitLiveSnapshot, GitRepositoryFacts };

export interface GitModuleOptions {
    readonly cacheMs?: number;
    readonly generation?: string;
    readonly maxCacheEntries?: number;
    readonly maxFiles?: number;
    readonly now?: () => number;
    readonly runner: GitCommandRunner;
}

interface CachedSnapshot {
    readonly expiresAt: number;
    readonly root: string;
    readonly snapshot: GitChangeSnapshot;
}

/**
 * HTTP-facing facade over the authoritative v1-parity scanner.
 *
 * Snapshots compare against the merge base with origin/main, include committed, staged, unstaged,
 * and untracked work, detect binary files, omit large files, and retain both sides of displayed
 * binary deltas.
 */
export class GitModule {
    readonly #cache = new Map<string, CachedSnapshot>();
    readonly #cacheMs: number;
    readonly #generation: string;
    readonly #maxCacheEntries: number;
    readonly #maxFiles: number;
    readonly #now: () => number;
    readonly #runner: GitCommandRunner;
    readonly #scanRunner: ScanGitRunner;
    #version = 0;

    constructor(options: GitModuleOptions) {
        this.#cacheMs = options.cacheMs ?? 2_000;
        this.#generation = options.generation ?? randomUUID();
        this.#maxCacheEntries = Math.max(1, options.maxCacheEntries ?? 32);
        this.#maxFiles = options.maxFiles ?? 1_000;
        this.#now = options.now ?? Date.now;
        this.#scanRunner = scanGitRunnerFromCommandRunner(options.runner);
        this.#runner = gitCommandRunnerFromScanGitRunner(this.#scanRunner);
    }

    generation(): string {
        return this.#generation;
    }

    async facts(root: string, signal?: AbortSignal): Promise<GitRepositoryFacts> {
        const probe = await probeGitRepository({
            git: this.#runner,
            path: root,
            ...(signal === undefined ? {} : { signal }),
        });
        return probe.facts ?? { ahead: 0, behind: 0, detached: false };
    }

    async snapshot(root: string, key = root, signal?: AbortSignal): Promise<GitChangeSnapshot> {
        const now = this.#now();
        this.#evictExpired(now);
        const cached = this.#cache.get(key);
        if (cached !== undefined && cached.expiresAt > now && cached.root === root) {
            this.#cache.delete(key);
            this.#cache.set(key, cached);
            return cached.snapshot;
        }
        const state = await scanGitRepository({
            now: this.#now,
            path: root,
            runGit: this.#scanRunner,
            ...(signal === undefined ? {} : { signal }),
        });
        const files = state.files.slice(0, this.#maxFiles);
        const snapshot: GitChangeSnapshot = {
            ...state,
            files,
            filesTruncated: state.filesTruncated || state.files.length > files.length,
            generation: this.#generation,
            version: ++this.#version,
        };
        this.#cache.delete(key);
        while (this.#cache.size >= this.#maxCacheEntries) {
            const oldest = this.#cache.keys().next().value as string | undefined;
            if (oldest === undefined) break;
            this.#cache.delete(oldest);
        }
        this.#cache.set(key, {
            expiresAt: now + this.#cacheMs,
            root,
            snapshot,
        });
        return snapshot;
    }

    async watch(
        entities: readonly (GitEntity & { readonly root: string })[],
    ): Promise<readonly GitLiveSnapshot[]> {
        const snapshots: GitLiveSnapshot[] = [];
        for (const entity of entities.slice(0, 256)) {
            const snapshot = await this.snapshot(
                entity.root,
                `${entity.projectId}:${entity.workspaceId ?? ""}`,
            );
            snapshots.push({
                createdAt: snapshot.scannedAt,
                data: { git: snapshot },
                id: randomUUID(),
                projectId: entity.projectId,
                type:
                    entity.workspaceId === undefined
                        ? "project_git_changed"
                        : "workspace_git_changed",
                ...(entity.workspaceId === undefined ? {} : { workspaceId: entity.workspaceId }),
            });
        }
        return snapshots;
    }

    invalidate(root?: string): void {
        if (root === undefined) {
            this.#cache.clear();
            return;
        }
        for (const [key, value] of this.#cache) {
            if (value.root === root) this.#cache.delete(key);
        }
    }

    dispose(): void {
        this.#cache.clear();
    }

    #evictExpired(now: number): void {
        for (const [key, cached] of this.#cache) {
            if (cached.expiresAt <= now) this.#cache.delete(key);
        }
    }
}
