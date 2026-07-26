import { afterEach, describe, expect, it, vi } from "vitest";

import type { GitChangeState } from "../protocol/index.js";
import {
    GitStateTracker,
    type GitChangeSnapshot,
    type GitTrackedEntity,
} from "./GitStateTracker.js";

const trackers: GitStateTracker[] = [];

afterEach(() => {
    for (const tracker of trackers.splice(0)) tracker.dispose();
});

describe("GitStateTracker", () => {
    it("publishes one snapshot for a burst of changes", async () => {
        const scan = countingScan();
        const published: GitChangeSnapshot[] = [];
        const tracker = createTracker({ onSnapshot: (_entity, s) => published.push(s), scan });

        tracker.watch(entity());
        for (let index = 0; index < 20; index += 1) tracker.markChanged(entity());
        await waitFor(() => published.length >= 1);
        await settle();

        expect(scan.calls).toBe(1);
        expect(published).toHaveLength(1);
        expect(published[0]?.version).toBe(1);
    });

    it("publishes nothing when a scan finds no difference", async () => {
        const scan = countingScan();
        const published: GitChangeSnapshot[] = [];
        const tracker = createTracker({ onSnapshot: (_entity, s) => published.push(s), scan });

        tracker.watch(entity());
        await waitFor(() => published.length === 1);
        await tracker.refresh(entity());
        await tracker.refresh(entity());

        expect(scan.calls).toBeGreaterThan(1);
        expect(published).toHaveLength(1);
    });

    it("publishes again when the repository actually changed", async () => {
        let insertions = 1;
        const scan = countingScan(() => ({ insertions }));
        const published: GitChangeSnapshot[] = [];
        const tracker = createTracker({ onSnapshot: (_entity, s) => published.push(s), scan });

        tracker.watch(entity());
        await waitFor(() => published.length === 1);
        insertions = 7;
        await tracker.refresh(entity());

        expect(published).toHaveLength(2);
        expect(published[1]).toMatchObject({ insertions: 7, version: 2 });
    });

    it("coalesces a change that arrives during a scan into exactly one rescan", async () => {
        let release = () => {};
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        let first = true;
        const scan = countingScan(
            () => ({}),
            async () => {
                if (!first) return;
                first = false;
                await gate;
            },
        );
        const tracker = createTracker({ scan });

        tracker.watch(entity());
        await waitFor(() => scan.calls === 1);
        tracker.markChanged(entity());
        tracker.markChanged(entity());
        tracker.markChanged(entity());
        release();
        await settle();

        expect(scan.calls).toBe(2);
    });

    it("keeps version numbers moving forward across eviction", async () => {
        const published: GitChangeSnapshot[] = [];
        let insertions = 1;
        const tracker = createTracker({
            onSnapshot: (_entity, s) => published.push(s),
            scan: countingScan(() => ({ insertions })),
            tuning: { trackedLimit: 1 },
        });

        tracker.watch(entity("a"));
        await waitFor(() => published.length === 1);
        // Watching a second entity evicts the first at this cap.
        tracker.watch(entity("b"));
        await waitFor(() => published.length === 2);
        expect(tracker.trackedKeys).toEqual(["project:b"]);
        insertions = 2;
        tracker.watch(entity("a"));
        await waitFor(() => published.length === 3);

        const revived = published.at(-1)!;
        // A re-tracked entity must not restart at 1, or a client that stored version 1 would
        // ignore every later snapshot forever.
        expect(revived.version).toBe(2);
    });

    it("drops an in-flight scan when its entity is evicted", async () => {
        let release = () => {};
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const published: GitChangeSnapshot[] = [];
        const tracker = createTracker({
            onSnapshot: (_entity, s) => published.push(s),
            scan: countingScan(
                () => ({}),
                async () => await gate,
            ),
        });

        tracker.watch(entity("a"));
        await settle();
        tracker.unwatch(entity("a"));
        release();
        await settle();

        expect(published).toHaveLength(0);
        expect(tracker.trackedKeys).toEqual([]);
    });

    it("stops scanning and closes its watches when disposed", async () => {
        const closed = vi.fn();
        const published: GitChangeSnapshot[] = [];
        const tracker = createTracker({
            onSnapshot: (_entity, s) => published.push(s),
            scan: countingScan(),
            watch: () => closed,
        });

        tracker.watch({ path: "/tmp/repo", projectId: "a" });
        await waitFor(() => published.length === 1);
        tracker.dispose();
        tracker.markChanged(entity());
        await settle();

        expect(closed).toHaveBeenCalledTimes(1);
        expect(published).toHaveLength(1);
        expect(tracker.trackedKeys).toEqual([]);
    });

    it("expires interest that a client stopped renewing", async () => {
        let clock = 1_000;
        const tracker = createTracker({
            now: () => clock,
            scan: countingScan(),
            tuning: { watchTtlMs: 500 },
        });

        tracker.watch(entity("a"));
        expect(tracker.trackedKeys).toEqual(["project:a"]);
        clock += 5_000;
        tracker.watch(entity("b"));

        expect(tracker.trackedKeys).toEqual(["project:b"]);
    });

    it("does not spin when a repository keeps failing", async () => {
        const scan = countingScan(() => {
            throw new Error("git exploded");
        });
        const tracker = createTracker({ scan });

        tracker.watch(entity());
        await waitFor(() => scan.calls === 1);
        await settle();

        // The retry is scheduled behind a backoff rather than re-queued immediately.
        expect(scan.calls).toBe(1);
    });

    it("owns a scan of its own when a refresh lands during one", async () => {
        let release = () => {};
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        let first = true;
        const scan = countingScan(
            () => ({}),
            async () => {
                if (!first) return;
                first = false;
                await gate;
            },
        );
        const tracker = createTracker({ scan });

        tracker.watch(entity());
        await waitFor(() => scan.calls === 1);
        const refreshed = tracker.refresh(entity());
        release();
        await refreshed;

        // Settling for the in-flight scan would make a forced refresh merely recent: that scan
        // read the repository before the caller asked.
        expect(scan.calls).toBeGreaterThanOrEqual(2);
    });

    it("backs off instead of spinning when a change arrives during a failing scan", async () => {
        const scan = countingScan(() => {
            throw new Error("git exploded");
        });
        const tracker = createTracker({ scan });

        tracker.watch(entity());
        await waitFor(() => scan.calls === 1);
        for (let index = 0; index < 10; index += 1) tracker.markChanged(entity());
        await settle();

        // The dirty-again re-enqueue must not bypass the backoff window.
        expect(scan.calls).toBe(1);
    });

    it("republishes after an observer throws instead of going quiet forever", async () => {
        let insertions = 1;
        let failNext = true;
        const published: GitChangeSnapshot[] = [];
        const tracker = createTracker({
            onLiveEvent: () => {
                if (!failNext) return;
                failNext = false;
                throw new Error("subscriber exploded");
            },
            onSnapshot: (_entity, snapshot) => published.push(snapshot),
            scan: countingScan(() => ({ insertions })),
        });

        tracker.watch(entity());
        await waitFor(() => published.length === 1);
        // The failed delivery must not be recorded as published: an unchanged repository would
        // then be suppressed by the equality check and the client would stay stale forever.
        await tracker.refresh(entity());

        expect(published.length).toBeGreaterThanOrEqual(2);
        expect(published.at(-1)).toMatchObject({ insertions: 1 });
    });

    it("serves the latest scan from a read even when its delivery failed", async () => {
        const tracker = createTracker({
            onLiveEvent: () => {
                throw new Error("subscriber exploded");
            },
            scan: countingScan(() => ({ insertions: 9 })),
        });

        const snapshot = await tracker.refresh(entity());

        // Reads report what was scanned; only republication is decided by what was delivered.
        expect(snapshot).toMatchObject({ insertions: 9 });
    });

    it("keeps scanning after a failing observer rather than treating it as a Git failure", async () => {
        const scan = countingScan();
        const tracker = createTracker({
            onSnapshot: () => {
                throw new Error("persistence exploded");
            },
            scan,
        });

        tracker.watch(entity());
        await waitFor(() => scan.calls === 1);
        await tracker.refresh(entity());

        // A local observer failure is not evidence the repository could not be read, so it must
        // not put the tracker into failure backoff.
        expect(scan.calls).toBeGreaterThanOrEqual(2);
    });

    it("answers a refresh for an entity it is not watching without retaining it", async () => {
        const tracker = createTracker({ scan: countingScan(() => ({ insertions: 5 })) });

        const snapshot = await tracker.refresh(entity("loose"));

        expect(snapshot).toMatchObject({ insertions: 5 });
        expect(tracker.trackedKeys).toEqual([]);
    });
});

function createTracker(
    options: ConstructorParameters<typeof GitStateTracker>[0] = {},
): GitStateTracker {
    const tracker = new GitStateTracker({
        tuning: {
            debounceMs: 1,
            maximumDebounceMs: 5,
            reconcileIntervalMs: 60_000,
            ...options.tuning,
        },
        ...options,
        runGit:
            options.runGit ??
            ((async () => ({
                stdout: "/tmp/repo/.git\n/tmp/repo/.git\n",
                truncated: false,
            })) as never),
        watch: options.watch ?? (() => () => {}),
    });
    trackers.push(tracker);
    return tracker;
}

function entity(projectId = "project-1"): GitTrackedEntity {
    return { path: `/tmp/${projectId}`, projectId };
}

function countingScan(
    overrides: () => Partial<GitChangeState> = () => ({}),
    before?: () => Promise<void>,
): ((options: { path: string }) => Promise<GitChangeState>) & { calls: number } {
    const scan = async (): Promise<GitChangeState> => {
        scan.calls += 1;
        await before?.();
        return {
            changedFiles: 0,
            comparison: "ready",
            conflicted: false,
            countsExact: true,
            deletions: 0,
            facts: { ahead: 0, behind: 0, detached: false },
            files: [],
            filesTruncated: false,
            insertions: 0,
            scannedAt: 0,
            ...overrides(),
        };
    };
    scan.calls = 0;
    return scan as never;
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("Timed out waiting for the tracker.");
}

async function settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 60));
}
