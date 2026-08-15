import { randomUUID } from "node:crypto";

import { Type, type Static } from "@sinclair/typebox";

import type { GitCommandResult, GitCommandRunner } from "../projects/ProjectHost.js";

export const gitEntitySchema = Type.Object(
    {
        projectId: Type.String({ minLength: 1, maxLength: 128 }),
        workspaceId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    },
    { additionalProperties: false },
);
export const gitWatchSchema = Type.Object(
    {
        entities: Type.Array(gitEntitySchema, { minItems: 1, maxItems: 256 }),
    },
    { additionalProperties: false },
);

export type GitEntity = Static<typeof gitEntitySchema>;
export type GitWatchInput = Static<typeof gitWatchSchema>;

export interface GitRepositoryFacts {
    readonly ahead: number;
    readonly behind: number;
    readonly branch?: string;
    readonly detached: boolean;
    readonly head?: string;
    readonly upstream?: string;
}

export interface GitChangedFile {
    readonly binary: boolean;
    readonly deletions?: number;
    readonly insertions?: number;
    readonly path: string;
    readonly staged: boolean;
    readonly status:
        | "added"
        | "conflicted"
        | "copied"
        | "deleted"
        | "modified"
        | "renamed"
        | "submodule"
        | "type_changed"
        | "untracked";
    readonly unstaged: boolean;
}

export interface GitChangeSnapshot {
    readonly base?: string;
    readonly changedFiles: number;
    readonly comparison: "ready" | "unavailable";
    readonly conflicted: boolean;
    readonly countsExact: boolean;
    readonly deletions: number;
    readonly error?: string;
    readonly files: readonly GitChangedFile[];
    readonly filesTruncated: boolean;
    readonly generation: string;
    readonly insertions: number;
    readonly scannedAt: number;
    readonly version: number;
    readonly facts: GitRepositoryFacts;
}

export interface GitLiveSnapshot {
    readonly createdAt: number;
    readonly data: { readonly git: GitChangeSnapshot };
    readonly id: string;
    readonly projectId: string;
    readonly type: "project_git_changed" | "workspace_git_changed";
    readonly workspaceId?: string;
}

export interface GitModuleOptions {
    readonly now?: () => number;
    readonly runner: GitCommandRunner;
    readonly generation?: string;
    readonly maxFiles?: number;
    readonly cacheMs?: number;
}

interface CachedSnapshot {
    readonly expiresAt: number;
    readonly root: string;
    readonly snapshot: GitChangeSnapshot;
}

export class GitModule {
    readonly #cache = new Map<string, CachedSnapshot>();
    readonly #cacheMs: number;
    readonly #generation: string;
    readonly #maxFiles: number;
    readonly #now: () => number;
    readonly #runner: GitCommandRunner;
    #version = 0;

    constructor(options: GitModuleOptions) {
        this.#cacheMs = options.cacheMs ?? 2_000;
        this.#generation = options.generation ?? randomUUID();
        this.#maxFiles = options.maxFiles ?? 2_000;
        this.#now = options.now ?? Date.now;
        this.#runner = options.runner;
    }

    generation(): string {
        return this.#generation;
    }

    async facts(root: string): Promise<GitRepositoryFacts> {
        const head = await this.#run(root, ["rev-parse", "--verify", "HEAD"]);
        const branch = await this.#run(root, ["branch", "--show-current"]);
        const upstream = await this.#run(root, [
            "rev-parse",
            "--abbrev-ref",
            "--symbolic-full-name",
            "@{u}",
        ]);
        const detached = branch.code !== 0 || branch.stdout.trim() === "";
        let ahead = 0;
        let behind = 0;
        if (upstream.code === 0) {
            const counts = await this.#run(root, [
                "rev-list",
                "--left-right",
                "--count",
                "@{u}...HEAD",
            ]);
            const values = counts.stdout.trim().split(/\s+/).map(Number);
            if (values.length === 2 && values.every(Number.isSafeInteger)) {
                behind = values[0] ?? 0;
                ahead = values[1] ?? 0;
            }
        }
        return {
            ahead,
            behind,
            ...(detached ? {} : { branch: branch.stdout.trim() }),
            detached,
            ...(head.code === 0 ? { head: head.stdout.trim() } : {}),
            ...(upstream.code === 0 ? { upstream: upstream.stdout.trim() } : {}),
        };
    }

    async snapshot(root: string, key = root): Promise<GitChangeSnapshot> {
        const now = this.#now();
        const cached = this.#cache.get(key);
        if (cached !== undefined && cached.expiresAt > now && cached.root === root) {
            return cached.snapshot;
        }
        const facts = await this.facts(root);
        const base = await this.#run(root, ["merge-base", "HEAD", "origin/main"]);
        const status = await this.#run(root, ["status", "--porcelain=v1", "-z"], {
            maxOutputBytes: 8 * 1024 * 1024,
        });
        const usableBase = base.code === 0 ? base.stdout.trim() : undefined;
        if (status.code !== 0) {
            const unavailable = this.#unavailable(facts, status.stderr || "Git status failed.");
            this.#cache.set(key, { expiresAt: now + this.#cacheMs, root, snapshot: unavailable });
            return unavailable;
        }
        const files = parseStatus(status.stdout).slice(0, this.#maxFiles);
        const truncated = parseStatus(status.stdout).length > this.#maxFiles;
        const numstat = await this.#run(root, ["diff", "--numstat"]);
        const counts =
            numstat.code === 0 ? parseNumstat(numstat.stdout) : { deletions: 0, insertions: 0 };
        const snapshot: GitChangeSnapshot = {
            ...(usableBase === undefined ? {} : { base: usableBase }),
            changedFiles: files.length,
            comparison: usableBase === undefined ? "unavailable" : "ready",
            conflicted: files.some((file) => file.status === "conflicted"),
            countsExact: numstat.code === 0 && !truncated,
            deletions: counts.deletions,
            ...(usableBase === undefined
                ? { error: "The repository has no origin/main merge base." }
                : {}),
            facts,
            files,
            filesTruncated: truncated,
            generation: this.#generation,
            insertions: counts.insertions,
            scannedAt: now,
            version: ++this.#version,
        };
        this.#cache.set(key, { expiresAt: now + this.#cacheMs, root, snapshot });
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

    async #run(
        root: string,
        args: readonly string[],
        options?: { readonly maxOutputBytes?: number },
    ): Promise<GitCommandResult> {
        return await this.#runner.run(root, args, options);
    }

    #unavailable(facts: GitRepositoryFacts, error: string): GitChangeSnapshot {
        return {
            changedFiles: 0,
            comparison: "unavailable",
            conflicted: false,
            countsExact: false,
            deletions: 0,
            error,
            facts,
            files: [],
            filesTruncated: false,
            generation: this.#generation,
            insertions: 0,
            scannedAt: this.#now(),
            version: ++this.#version,
        };
    }
}

function parseStatus(value: string): GitChangedFile[] {
    const entries = value.split("\0").filter(Boolean);
    return entries.map((entry) => {
        const index = entry[0] ?? " ";
        const worktree = entry[1] ?? " ";
        const rawPath = entry.slice(3);
        const status = statusFrom(index, worktree);
        return {
            binary: false,
            path: rawPath,
            staged: index !== " " && index !== "?",
            status,
            unstaged: worktree !== " " && worktree !== "?",
        };
    });
}

function parseNumstat(value: string): { readonly deletions: number; readonly insertions: number } {
    let deletions = 0;
    let insertions = 0;
    for (const line of value.split("\n")) {
        const [added, removed] = line.split("\t");
        const addedNumber = Number(added);
        const removedNumber = Number(removed);
        if (Number.isSafeInteger(addedNumber)) insertions += addedNumber;
        if (Number.isSafeInteger(removedNumber)) deletions += removedNumber;
    }
    return { deletions, insertions };
}

function statusFrom(index: string, worktree: string): GitChangedFile["status"] {
    if (index === "U" || worktree === "U" || (index === "A" && worktree === "A")) {
        return "conflicted";
    }
    if (index === "?" || worktree === "?") return "untracked";
    if (index === "A" || worktree === "A") return "added";
    if (index === "D" || worktree === "D") return "deleted";
    if (index === "R" || worktree === "R") return "renamed";
    if (index === "C" || worktree === "C") return "copied";
    if (index === "T" || worktree === "T") return "type_changed";
    return "modified";
}
