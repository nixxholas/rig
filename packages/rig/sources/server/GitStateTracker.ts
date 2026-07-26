import { createId } from "@paralleldrive/cuid2";

import type { GitChangeState } from "../protocol/index.js";
import { scanGitRepository } from "./scanGitRepository.js";
import type { TaskDrain } from "./TrackedTaskDrain.js";
import { watchGitRepositoryChanges } from "./watchGitRepositoryChanges.js";

const WATCH_TTL_MS = 5 * 60 * 1000;
const TRACKED_LIMIT = 32;
const SCAN_CONCURRENCY = 4;
const DEBOUNCE_MS = 150;
const MAXIMUM_DEBOUNCE_MS = 750;
/**
 * Node does not surface inotify queue overflow, so watches cannot promise completeness on their
 * own. This poll is the completeness guarantee; the watches are the latency optimisation.
 */
const RECONCILE_INTERVAL_MS = 30_000;
const BACKOFF_START_MS = 1_000;
const BACKOFF_LIMIT_MS = 30_000;

export interface GitTrackedEntity {
    /** Immutable commit a managed workspace was created from. */
    baseCommit?: string;
    /** Per-worktree Git directory. */
    gitDirectory?: string;
    /** Common Git directory shared with linked worktrees. */
    gitCommonDirectory?: string;
    path: string;
    projectId: string;
    workspaceId?: string;
}

export interface GitChangeSnapshot extends GitChangeState {
    /** Identity of the daemon run, so a client can tell a restart from an update. */
    generation: string;
    /** Monotonic within one generation; survives eviction so a client never regresses. */
    version: number;
}

export interface GitStateTrackerOptions {
    now?: () => number;
    onSnapshot?: (entity: GitTrackedEntity, snapshot: GitChangeSnapshot) => void;
    /** Test seam for the scanner. */
    scan?: typeof scanGitRepository;
    taskDrain?: TaskDrain;
    tuning?: {
        debounceMs?: number;
        maximumDebounceMs?: number;
        reconcileIntervalMs?: number;
        trackedLimit?: number;
        watchTtlMs?: number;
    };
    /** Test seam for the watcher. */
    watch?: typeof watchGitRepositoryChanges;
}

interface RepositoryTracker {
    backoffMs: number;
    debounceTimer: NodeJS.Timeout | undefined;
    dirtyAgain: boolean;
    entity: GitTrackedEntity;
    expiresAt: number;
    firstDirtyAt: number | undefined;
    /** Incremented on eviction and disposal so in-flight work can detect it is obsolete. */
    generation: number;
    key: string;
    lastActiveAt: number;
    reconcileTimer: NodeJS.Timeout | undefined;
    scanning: boolean;
    scanController: AbortController | undefined;
    snapshot: GitChangeSnapshot | undefined;
    unwatch: (() => void) | undefined;
}

/**
 * Keeps a live Git change snapshot for the entities a client is actually looking at.
 *
 * Interest is explicit and expires: nothing is watched because it exists, only because a client
 * asked for it or a session is running in it. That is what bounds descriptors, subprocesses, and
 * timers; the caps below are a second line of defence.
 */
export class GitStateTracker {
    readonly #generation = createId();
    readonly #now: () => number;
    readonly #onSnapshot:
        | ((entity: GitTrackedEntity, snapshot: GitChangeSnapshot) => void)
        | undefined;
    readonly #pendingScans: string[] = [];
    readonly #scan: typeof scanGitRepository;
    readonly #taskDrain: TaskDrain | undefined;
    readonly #trackers = new Map<string, RepositoryTracker>();
    readonly #tuning: Required<NonNullable<GitStateTrackerOptions["tuning"]>>;
    /** Version counters outlive their tracker so a re-tracked entity never restarts at 1. */
    readonly #versions = new Map<string, number>();
    readonly #watch: typeof watchGitRepositoryChanges;
    #activeScans = 0;
    #disposed = false;

    constructor(options: GitStateTrackerOptions = {}) {
        this.#now = options.now ?? Date.now;
        this.#onSnapshot = options.onSnapshot;
        this.#scan = options.scan ?? scanGitRepository;
        this.#taskDrain = options.taskDrain;
        this.#watch = options.watch ?? watchGitRepositoryChanges;
        this.#tuning = {
            debounceMs: options.tuning?.debounceMs ?? DEBOUNCE_MS,
            maximumDebounceMs: options.tuning?.maximumDebounceMs ?? MAXIMUM_DEBOUNCE_MS,
            reconcileIntervalMs: options.tuning?.reconcileIntervalMs ?? RECONCILE_INTERVAL_MS,
            trackedLimit: options.tuning?.trackedLimit ?? TRACKED_LIMIT,
            watchTtlMs: options.tuning?.watchTtlMs ?? WATCH_TTL_MS,
        };
    }

    get generation(): string {
        return this.#generation;
    }

    /** Entities currently held, most recently active first. */
    get trackedKeys(): readonly string[] {
        return [...this.#trackers.values()]
            .sort((left, right) => right.lastActiveAt - left.lastActiveAt)
            .map((tracker) => tracker.key);
    }

    /** Declares or renews interest in an entity and starts watching it. */
    watch(entity: GitTrackedEntity): void {
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
            debounceTimer: undefined,
            dirtyAgain: false,
            entity,
            expiresAt: this.#now() + this.#tuning.watchTtlMs,
            firstDirtyAt: undefined,
            generation: 0,
            key,
            lastActiveAt: this.#now(),
            reconcileTimer: undefined,
            scanController: undefined,
            scanning: false,
            snapshot: undefined,
            unwatch: undefined,
        };
        this.#trackers.set(key, tracker);
        this.#evictExpired();
        if (!this.#trackers.has(key)) return;
        this.#arm(tracker);
        this.markChanged(entity);
    }

    /** Stops watching an entity, for example once its workspace is archived. */
    unwatch(entity: GitTrackedEntity): void {
        const tracker = this.#trackers.get(entityKey(entity));
        if (tracker !== undefined) this.#retire(tracker);
    }

    snapshot(entity: GitTrackedEntity): GitChangeSnapshot | undefined {
        return this.#trackers.get(entityKey(entity))?.snapshot;
    }

    /** Records that something may have changed. Cheap, and the primary signal for Rig's own writes. */
    markChanged(entity: GitTrackedEntity): void {
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

    /** Scans now and resolves with the fresh snapshot, bypassing the debounce. */
    async refresh(entity: GitTrackedEntity): Promise<GitChangeSnapshot | undefined> {
        if (this.#disposed) return undefined;
        const key = entityKey(entity);
        const tracker = this.#trackers.get(key);
        if (tracker === undefined) {
            // A refresh for an unwatched entity is still answered, without retaining it.
            return this.#stamp(key, await this.#runScan(entity));
        }
        tracker.lastActiveAt = this.#now();
        await this.#scanTracker(tracker);
        return tracker.snapshot;
    }

    dispose(): void {
        if (this.#disposed) return;
        this.#disposed = true;
        this.#pendingScans.length = 0;
        // Copied first because retiring deletes from the map being iterated.
        for (const tracker of Array.from(this.#trackers.values())) this.#retire(tracker);
    }

    #arm(tracker: RepositoryTracker): void {
        const { gitCommonDirectory, gitDirectory, path } = tracker.entity;
        if (gitDirectory !== undefined && gitCommonDirectory !== undefined) {
            tracker.unwatch = this.#watch({
                commonDirectory: gitCommonDirectory,
                gitDirectory,
                onDirty: () => this.markChanged(tracker.entity),
                path,
            });
        }
        const timer = setInterval(() => {
            this.#enqueue(tracker.key);
        }, this.#tuning.reconcileIntervalMs);
        timer.unref?.();
        tracker.reconcileTimer = timer;
    }

    /**
     * Ends a tracker for good. The generation bump is what makes an in-flight scan harmless: it
     * completes, sees that it is obsolete, and publishes nothing.
     */
    #retire(tracker: RepositoryTracker): void {
        tracker.generation += 1;
        tracker.scanController?.abort();
        tracker.scanController = undefined;
        tracker.dirtyAgain = false;
        if (tracker.debounceTimer !== undefined) clearTimeout(tracker.debounceTimer);
        tracker.debounceTimer = undefined;
        if (tracker.reconcileTimer !== undefined) clearInterval(tracker.reconcileTimer);
        tracker.reconcileTimer = undefined;
        tracker.unwatch?.();
        tracker.unwatch = undefined;
        this.#trackers.delete(tracker.key);
    }

    #evictExpired(): void {
        const now = this.#now();
        // Copied first because retiring deletes from the map being iterated.
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
        if (this.#disposed || this.#taskDrain?.closing === true) return;
        const tracker = this.#trackers.get(key);
        if (tracker === undefined) return;
        if (tracker.scanning) {
            tracker.dirtyAgain = true;
            return;
        }
        if (this.#pendingScans.includes(key)) return;
        this.#pendingScans.push(key);
        this.#drain();
    }

    #drain(): void {
        while (this.#activeScans < SCAN_CONCURRENCY) {
            const key = this.#pendingScans.shift();
            if (key === undefined) return;
            const tracker = this.#trackers.get(key);
            if (tracker === undefined) continue;
            this.#activeScans += 1;
            const run = async () => {
                try {
                    await this.#scanTracker(tracker);
                } finally {
                    this.#activeScans -= 1;
                    this.#drain();
                }
            };
            const task = this.#taskDrain?.run(run) ?? run();
            void task.catch(() => undefined);
        }
    }

    async #scanTracker(tracker: RepositoryTracker): Promise<void> {
        if (this.#disposed || tracker.scanning) return;
        const generation = tracker.generation;
        const controller = new AbortController();
        tracker.scanning = true;
        tracker.scanController = controller;
        try {
            const state = await this.#runScan(tracker.entity, controller.signal);
            if (this.#disposed || tracker.generation !== generation) return;
            if (!sameState(tracker.snapshot, state)) {
                const snapshot = this.#stamp(tracker.key, state);
                tracker.snapshot = snapshot;
                this.#onSnapshot?.(tracker.entity, snapshot);
            }
            tracker.backoffMs = BACKOFF_START_MS;
        } catch {
            if (this.#disposed || tracker.generation !== generation) return;
            // A repository that keeps failing backs off instead of spinning on every dirty signal.
            const delay = tracker.backoffMs;
            tracker.backoffMs = Math.min(BACKOFF_LIMIT_MS, tracker.backoffMs * 2);
            const timer = setTimeout(() => {
                this.#enqueue(tracker.key);
            }, delay);
            timer.unref?.();
        } finally {
            tracker.scanning = false;
            tracker.scanController = undefined;
            if (tracker.dirtyAgain && tracker.generation === generation && !this.#disposed) {
                tracker.dirtyAgain = false;
                this.#enqueue(tracker.key);
            }
        }
    }

    async #runScan(entity: GitTrackedEntity, signal?: AbortSignal): Promise<GitChangeState> {
        return await this.#scan({
            ...(entity.baseCommit === undefined ? {} : { baseCommit: entity.baseCommit }),
            now: this.#now,
            path: entity.path,
            ...(signal === undefined ? {} : { signal }),
        });
    }

    #stamp(key: string, state: GitChangeState): GitChangeSnapshot {
        const version = (this.#versions.get(key) ?? 0) + 1;
        this.#versions.set(key, version);
        return { ...state, generation: this.#generation, version };
    }
}

export function entityKey(entity: GitTrackedEntity): string {
    return entity.workspaceId === undefined
        ? `project:${entity.projectId}`
        : `workspace:${entity.workspaceId}`;
}

/**
 * Scan-to-scan equality. Timestamps and identity are excluded so an unchanged repository publishes
 * nothing at all; otherwise every poll would look like a change.
 */
function sameState(left: GitChangeSnapshot | undefined, right: GitChangeState): boolean {
    if (left === undefined) return false;
    const { generation: _generation, scannedAt: _leftAt, version: _version, ...previous } = left;
    const { scannedAt: _rightAt, ...next } = right;
    return JSON.stringify(previous) === JSON.stringify(next);
}
