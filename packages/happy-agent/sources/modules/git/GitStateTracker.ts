import { randomUUID } from "node:crypto";

import { Type, type Static } from "@sinclair/typebox";
import type { Context, RootContext } from "@steve.kite/stdlib";

import { runScanGit, type ScanGitResult } from "./runScanGit.js";
import { scanGitRepository } from "./scanGitRepository.js";
import {
    gitChangeSnapshotSchema,
    gitTrackedEntitySchema,
    type GitChangeSnapshot,
    type GitChangeState,
    type GitTrackedEntity,
} from "./types.js";
import {
    watchGitRepositoryChanges,
    type GitRepositoryWatchOptions,
} from "./watchGitRepositoryChanges.js";

const WATCH_TTL_MS = 5 * 60 * 1000;
const TRACKED_LIMIT = 32;
const SCAN_CONCURRENCY = 4;
const DEBOUNCE_MS = 150;
const MAXIMUM_DEBOUNCE_MS = 750;
const RECONCILE_INTERVAL_MS = 30_000;
const BACKOFF_START_MS = 1_000;
const BACKOFF_LIMIT_MS = 30_000;

export { gitTrackedEntitySchema };
export type { GitChangeSnapshot, GitTrackedEntity };

export const gitLiveSnapshotSchema = Type.Object(
    {
        createdAt: Type.Number(),
        data: Type.Object({ git: gitChangeSnapshotSchema }),
        id: Type.String({ minLength: 1 }),
        projectId: Type.String({ minLength: 1 }),
        type: Type.Union([
            Type.Literal("project_git_changed"),
            Type.Literal("workspace_git_changed"),
        ]),
        workspaceId: Type.Optional(Type.String({ minLength: 1 })),
    },
    { additionalProperties: false },
);
export type GitLiveSnapshot = Static<typeof gitLiveSnapshotSchema>;

export const gitStateTrackerTuningSchema = Type.Object(
    {
        debounceMs: Type.Optional(Type.Integer({ minimum: 0 })),
        maximumDebounceMs: Type.Optional(Type.Integer({ minimum: 0 })),
        reconcileIntervalMs: Type.Optional(Type.Integer({ minimum: 1 })),
        trackedLimit: Type.Optional(Type.Integer({ minimum: 1 })),
        watchTtlMs: Type.Optional(Type.Integer({ minimum: 1 })),
    },
    { additionalProperties: false },
);
export type GitStateTrackerTuning = Static<typeof gitStateTrackerTuningSchema>;

export interface GitStateTrackerOptions {
    now?: () => number;
    onLiveEvent?: (ctx: Context, event: GitLiveSnapshot) => boolean;
    onObserverError?: (ctx: Context, error: unknown, entity: GitTrackedEntity) => void;
    onSnapshot?: (
        ctx: Context,
        entity: GitTrackedEntity,
        snapshot: GitChangeSnapshot,
    ) => void | Promise<void>;
    rootContext: RootContext;
    runGit?: (options: {
        args: readonly string[];
        cwd: string;
        signal?: AbortSignal;
    }) => Promise<ScanGitResult>;
    scan?: typeof scanGitRepository;
    tuning?: GitStateTrackerTuning;
    watch?: (rootContext: RootContext, options: GitRepositoryWatchOptions) => () => void;
}

interface RepositoryTracker {
    backoffMs: number;
    backoffTimer: NodeJS.Timeout | undefined;
    backoffUntil: number;
    debounceTimer: NodeJS.Timeout | undefined;
    dirtyAgain: boolean;
    entity: GitTrackedEntity;
    expiresAt: number;
    firstDirtyAt: number | undefined;
    generation: number;
    inFlight: Promise<void> | undefined;
    key: string;
    lastActiveAt: number;
    reconcileTimer: NodeJS.Timeout | undefined;
    scanController: AbortController | undefined;
    scanning: boolean;
    snapshot: GitChangeSnapshot | undefined;
    snapshotDelivered: boolean;
    unwatch: (() => void) | undefined;
}

export class GitStateTracker {
    readonly #ctx: Context;
    readonly #generation = randomUUID();
    readonly #now: () => number;
    readonly #onLiveEvent: GitStateTrackerOptions["onLiveEvent"];
    readonly #onObserverError: GitStateTrackerOptions["onObserverError"];
    readonly #onSnapshot: GitStateTrackerOptions["onSnapshot"];
    readonly #pendingScans: string[] = [];
    readonly #rootContext: RootContext;
    readonly #runGit: NonNullable<GitStateTrackerOptions["runGit"]>;
    readonly #scan: typeof scanGitRepository;
    readonly #trackers = new Map<string, RepositoryTracker>();
    readonly #tuning: Required<GitStateTrackerTuning>;
    readonly #watch: NonNullable<GitStateTrackerOptions["watch"]>;
    #activeScans = 0;
    #disposed = false;
    #nextVersion = 0;

    constructor(options: GitStateTrackerOptions) {
        this.#rootContext = options.rootContext;
        this.#ctx = options.rootContext.named("git-state-tracker");
        this.#now = options.now ?? Date.now;
        this.#onLiveEvent = options.onLiveEvent;
        this.#onObserverError = options.onObserverError;
        this.#onSnapshot = options.onSnapshot;
        this.#runGit = options.runGit ?? runScanGit;
        this.#scan = options.scan ?? scanGitRepository;
        this.#watch = options.watch ?? watchGitRepositoryChanges;
        this.#tuning = {
            debounceMs: options.tuning?.debounceMs ?? DEBOUNCE_MS,
            maximumDebounceMs: options.tuning?.maximumDebounceMs ?? MAXIMUM_DEBOUNCE_MS,
            reconcileIntervalMs: options.tuning?.reconcileIntervalMs ?? RECONCILE_INTERVAL_MS,
            trackedLimit: options.tuning?.trackedLimit ?? TRACKED_LIMIT,
            watchTtlMs: options.tuning?.watchTtlMs ?? WATCH_TTL_MS,
        };
        this.#ctx.lifetime?.addEventListener("abort", () => this.dispose(), { once: true });
    }

    get generation(): string {
        return this.#generation;
    }

    get trackedKeys(): readonly string[] {
        return [...this.#trackers.values()]
            .sort((left, right) => right.lastActiveAt - left.lastActiveAt)
            .map((tracker) => tracker.key);
    }

    watch(ctx: Context, entity: GitTrackedEntity): void {
        void ctx;
        if (this.#disposed) return;
        const key = entityKey(entity);
        const existing = this.#trackers.get(key);
        if (existing !== undefined) {
            existing.entity = entity;
            existing.expiresAt = this.#now() + this.#tuning.watchTtlMs;
            existing.lastActiveAt = this.#now();
            return;
        }
        const tracker: RepositoryTracker = {
            backoffMs: BACKOFF_START_MS,
            backoffTimer: undefined,
            backoffUntil: 0,
            debounceTimer: undefined,
            dirtyAgain: false,
            entity,
            expiresAt: this.#now() + this.#tuning.watchTtlMs,
            firstDirtyAt: undefined,
            generation: 0,
            inFlight: undefined,
            key,
            lastActiveAt: this.#now(),
            reconcileTimer: undefined,
            scanController: undefined,
            scanning: false,
            snapshot: undefined,
            snapshotDelivered: false,
            unwatch: undefined,
        };
        this.#trackers.set(key, tracker);
        this.#evictExpired();
        if (!this.#trackers.has(key)) return;
        this.#arm(tracker);
        this.markChanged(this.#ctx, entity);
    }

    unwatch(ctx: Context, entity: GitTrackedEntity): void {
        void ctx;
        const tracker = this.#trackers.get(entityKey(entity));
        if (tracker !== undefined) this.#retire(tracker);
    }

    markChanged(ctx: Context, entity: GitTrackedEntity): void {
        void ctx;
        const tracker = this.#trackers.get(entityKey(entity));
        if (tracker === undefined || this.#disposed) return;
        tracker.lastActiveAt = this.#now();
        if (tracker.scanning) {
            tracker.dirtyAgain = true;
            return;
        }
        tracker.firstDirtyAt ??= this.#now();
        const waited = this.#now() - tracker.firstDirtyAt;
        const delay = Math.max(
            0,
            Math.min(this.#tuning.debounceMs, this.#tuning.maximumDebounceMs - waited),
        );
        if (tracker.debounceTimer !== undefined) clearTimeout(tracker.debounceTimer);
        tracker.debounceTimer = setTimeout(() => {
            tracker.debounceTimer = undefined;
            tracker.firstDirtyAt = undefined;
            this.#enqueue(tracker.key);
        }, delay);
        tracker.debounceTimer.unref?.();
    }

    snapshot(entity: GitTrackedEntity): GitChangeSnapshot | undefined {
        return this.#trackers.get(entityKey(entity))?.snapshot;
    }

    liveSnapshots(): readonly GitLiveSnapshot[] {
        return [...this.#trackers.values()]
            .filter(
                (tracker): tracker is RepositoryTracker & { snapshot: GitChangeSnapshot } =>
                    tracker.snapshot !== undefined,
            )
            .map((tracker) => this.#createLiveEvent(tracker.entity, tracker.snapshot));
    }

    async refresh(ctx: Context, entity: GitTrackedEntity): Promise<GitChangeSnapshot | undefined> {
        if (this.#disposed) return undefined;
        const tracker = this.#trackers.get(entityKey(entity));
        if (tracker === undefined) return this.#stamp(await this.#runScan(entity));
        tracker.lastActiveAt = this.#now();
        for (let attempt = 0; attempt < 3; attempt += 1) {
            await tracker.inFlight?.catch(() => undefined);
            if (this.#disposed || this.#trackers.get(tracker.key) !== tracker) break;
            if (!tracker.scanning) {
                await this.#scanTracker(ctx, tracker);
                break;
            }
        }
        return tracker.snapshot;
    }

    dispose(): void {
        if (this.#disposed) return;
        this.#disposed = true;
        this.#pendingScans.length = 0;
        for (const tracker of Array.from(this.#trackers.values())) this.#retire(tracker);
    }

    #arm(tracker: RepositoryTracker): void {
        const timer = setInterval(() => {
            this.#evictExpired();
            if (this.#trackers.get(tracker.key) === tracker) this.#enqueue(tracker.key);
        }, this.#tuning.reconcileIntervalMs);
        timer.unref?.();
        tracker.reconcileTimer = timer;
        const generation = tracker.generation;
        void this.#resolveGitDirectories(tracker.entity.path)
            .then((directories) => {
                if (
                    directories === undefined ||
                    this.#disposed ||
                    tracker.generation !== generation
                ) {
                    return;
                }
                tracker.unwatch = this.#watch(this.#rootContext, {
                    commonDirectory: directories.commonDirectory,
                    gitDirectory: directories.gitDirectory,
                    onDirty: () => this.markChanged(this.#ctx, tracker.entity),
                    path: tracker.entity.path,
                });
            })
            .catch(() => undefined);
    }

    async #resolveGitDirectories(
        path: string,
    ): Promise<{ commonDirectory: string; gitDirectory: string } | undefined> {
        try {
            const result = await this.#runGit({
                args: ["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"],
                cwd: path,
            });
            const [gitDirectory, commonDirectory] = result.stdout
                .split("\n")
                .map((line) => line.trim())
                .filter(Boolean);
            return gitDirectory === undefined
                ? undefined
                : { commonDirectory: commonDirectory ?? gitDirectory, gitDirectory };
        } catch {
            return undefined;
        }
    }

    #retire(tracker: RepositoryTracker): void {
        tracker.generation += 1;
        if (tracker.backoffTimer !== undefined) clearTimeout(tracker.backoffTimer);
        if (tracker.debounceTimer !== undefined) clearTimeout(tracker.debounceTimer);
        if (tracker.reconcileTimer !== undefined) clearInterval(tracker.reconcileTimer);
        tracker.scanController?.abort();
        tracker.unwatch?.();
        this.#trackers.delete(tracker.key);
    }

    #evictExpired(): void {
        const now = this.#now();
        for (const tracker of Array.from(this.#trackers.values())) {
            if (tracker.expiresAt <= now) this.#retire(tracker);
        }
        while (this.#trackers.size > this.#tuning.trackedLimit) {
            const oldest = [...this.#trackers.values()].reduce((left, right) =>
                left.lastActiveAt <= right.lastActiveAt ? left : right,
            );
            this.#retire(oldest);
        }
    }

    #enqueue(key: string): void {
        if (this.#disposed) return;
        const tracker = this.#trackers.get(key);
        if (tracker === undefined) return;
        if (tracker.backoffTimer !== undefined && this.#now() < tracker.backoffUntil) return;
        if (tracker.scanning) {
            tracker.dirtyAgain = true;
            return;
        }
        if (!this.#pendingScans.includes(key)) this.#pendingScans.push(key);
        this.#drain();
    }

    #drain(): void {
        if (this.#disposed) return;
        while (this.#activeScans < SCAN_CONCURRENCY) {
            const key = this.#pendingScans.shift();
            if (key === undefined) return;
            const tracker = this.#trackers.get(key);
            if (tracker === undefined) continue;
            this.#activeScans += 1;
            void this.#scanTracker(this.#ctx, tracker)
                .catch((error: unknown) => this.#report(this.#ctx, error, tracker.entity))
                .finally(() => {
                    this.#activeScans -= 1;
                    this.#drain();
                });
        }
    }

    async #scanTracker(ctx: Context, tracker: RepositoryTracker): Promise<void> {
        if (this.#disposed || tracker.scanning) return;
        const scan = this.#runScanTracker(ctx, tracker);
        tracker.inFlight = scan;
        try {
            await scan;
        } finally {
            if (tracker.inFlight === scan) tracker.inFlight = undefined;
        }
    }

    async #runScanTracker(ctx: Context, tracker: RepositoryTracker): Promise<void> {
        const generation = tracker.generation;
        const controller = new AbortController();
        tracker.scanning = true;
        tracker.scanController = controller;
        try {
            const state = await this.#runScan(tracker.entity, controller.signal);
            if (this.#disposed || tracker.generation !== generation) return;
            const unchanged = tracker.snapshot !== undefined && sameState(tracker.snapshot, state);
            if (!unchanged || !tracker.snapshotDelivered) {
                const snapshot =
                    unchanged && tracker.snapshot !== undefined
                        ? tracker.snapshot
                        : this.#stamp(state);
                tracker.snapshot = snapshot;
                tracker.snapshotDelivered = await this.#deliver(ctx, tracker.entity, snapshot);
            }
            tracker.backoffMs = BACKOFF_START_MS;
            tracker.backoffUntil = 0;
            if (tracker.backoffTimer !== undefined) clearTimeout(tracker.backoffTimer);
            tracker.backoffTimer = undefined;
        } catch (error) {
            if (this.#disposed || tracker.generation !== generation) return;
            const delay = tracker.backoffMs;
            tracker.backoffMs = Math.min(BACKOFF_LIMIT_MS, tracker.backoffMs * 2);
            tracker.backoffUntil = this.#now() + delay;
            if (tracker.backoffTimer !== undefined) clearTimeout(tracker.backoffTimer);
            tracker.backoffTimer = setTimeout(() => {
                tracker.backoffTimer = undefined;
                this.#enqueue(tracker.key);
            }, delay);
            tracker.backoffTimer.unref?.();
            this.#report(ctx, error, tracker.entity);
        } finally {
            tracker.scanning = false;
            tracker.scanController = undefined;
            if (tracker.dirtyAgain && tracker.generation === generation && !this.#disposed) {
                tracker.dirtyAgain = false;
                this.#enqueue(tracker.key);
            }
        }
    }

    async #deliver(
        ctx: Context,
        entity: GitTrackedEntity,
        snapshot: GitChangeSnapshot,
    ): Promise<boolean> {
        // The snapshot observer owns durable Git-facts persistence. A failure there is retryable
        // delivery work, not successful publication; letting it reach the scan failure path keeps
        // the same snapshot pending behind the tracker's bounded backoff.
        await this.#onSnapshot?.(ctx, entity, snapshot);
        if (this.#onLiveEvent === undefined) return true;
        try {
            return this.#onLiveEvent(ctx, this.#createLiveEvent(entity, snapshot));
        } catch (error) {
            this.#report(ctx, error, entity);
            return false;
        }
    }

    #report(ctx: Context, error: unknown, entity: GitTrackedEntity): void {
        try {
            this.#onObserverError?.(ctx, error, entity);
        } catch {
            // Failure reporting never breaks tracking.
        }
    }

    async #runScan(entity: GitTrackedEntity, signal?: AbortSignal): Promise<GitChangeState> {
        return await this.#scan({
            now: this.#now,
            path: entity.path,
            runGit: this.#runGit,
            ...(signal === undefined ? {} : { signal }),
        });
    }

    #stamp(state: GitChangeState): GitChangeSnapshot {
        this.#nextVersion += 1;
        return { ...state, generation: this.#generation, version: this.#nextVersion };
    }

    #createLiveEvent(entity: GitTrackedEntity, git: GitChangeSnapshot): GitLiveSnapshot {
        return {
            createdAt: this.#now(),
            data: { git },
            id: randomUUID(),
            projectId: entity.projectId,
            type:
                entity.workspaceId === undefined ? "project_git_changed" : "workspace_git_changed",
            ...(entity.workspaceId === undefined ? {} : { workspaceId: entity.workspaceId }),
        };
    }
}

export function entityKey(entity: GitTrackedEntity): string {
    return entity.workspaceId === undefined
        ? `project:${entity.projectId}`
        : `workspace:${entity.workspaceId}`;
}

function sameState(left: GitChangeSnapshot | undefined, right: GitChangeState): boolean {
    if (left === undefined) return false;
    const { generation: _generation, scannedAt: _leftAt, version: _version, ...previous } = left;
    const { scannedAt: _rightAt, ...next } = right;
    return JSON.stringify(previous) === JSON.stringify(next);
}
