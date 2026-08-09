import { createClient } from "@libsql/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { GitChangeState } from "../../protocol/index.js";
import { InMemoryGlobalEventQueue } from "../../global-event/InMemoryGlobalEventQueue.js";
import {
    GitStateTracker,
    type GitChangeSnapshot,
    type GitTrackedEntity,
} from "../GitStateTracker.js";
import { TrackedTaskDrain } from "../../utils/TrackedTaskDrain.js";

const trackers: GitStateTracker[] = [];

afterEach(() => {
    for (const tracker of trackers.splice(0)) tracker.dispose();
});

describe("GitStateTracker", () => {
    it("publishes one snapshot for a burst of changes", async () => {
        const scan = countingScan();
        const published: GitChangeSnapshot[] = [];
        const tracker = createTracker({
            onSnapshot: (_entity, s) => {
                published.push(s);
            },
            scan,
        });

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
        const tracker = createTracker({
            onSnapshot: (_entity, s) => {
                published.push(s);
            },
            scan,
        });

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
        const tracker = createTracker({
            onSnapshot: (_entity, s) => {
                published.push(s);
            },
            scan,
        });

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
            onSnapshot: (_entity, s) => {
                published.push(s);
            },
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

        const evictedVersion = published[0]!.version;
        // A re-tracked entity must never reissue or regress a version, or a client holding the
        // earlier one would ignore every later snapshot forever.
        expect(published.at(-1)!.version).toBeGreaterThan(evictedVersion);
    });

    it("drops an in-flight scan when its entity is evicted", async () => {
        let release = () => {};
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const published: GitChangeSnapshot[] = [];
        const tracker = createTracker({
            onSnapshot: (_entity, s) => {
                published.push(s);
            },
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
            onSnapshot: (_entity, s) => {
                published.push(s);
            },
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

    it("drains an async snapshot observer before shutdown completes", async () => {
        let observerStarted!: () => void;
        const started = new Promise<void>((resolve) => {
            observerStarted = resolve;
        });
        let releaseObserver!: () => void;
        const observer = new Promise<void>((resolve) => {
            releaseObserver = resolve;
        });
        let persisted = false;
        const taskDrain = new TrackedTaskDrain();
        const tracker = createTracker({
            onSnapshot: async () => {
                observerStarted();
                await observer;
                persisted = true;
            },
            scan: countingScan(),
            taskDrain,
        });

        tracker.watch(entity());
        await started;
        tracker.dispose();
        let drained = false;
        const draining = taskDrain.drain().then(() => {
            drained = true;
        });

        expect(drained).toBe(false);
        expect(persisted).toBe(false);
        releaseObserver();
        await draining;

        expect(persisted).toBe(true);
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

    it("does not let a replaced backoff timer fire inside the new window", async () => {
        const scan = countingScan(() => {
            throw new Error("git exploded");
        });
        const tracker = createTracker({ scan });

        tracker.watch(entity());
        await waitFor(() => scan.calls === 1);
        // A forced refresh during the first backoff fails too and installs a longer window. If the
        // timer it replaces is left armed, it fires inside that window and defeats the throttle.
        await tracker.refresh(entity());
        const afterRefresh = scan.calls;
        await new Promise((resolve) => setTimeout(resolve, 1_400));

        expect(scan.calls).toBe(afterRefresh);
    }, 10_000);

    it("republishes through the real queue after a subscriber throws", async () => {
        // Wired the way the daemon wires it, through publishLive rather than a hand-rolled
        // callback. An earlier version isolated subscribers inside the queue and asked the tracker
        // to detect failures, which cancelled out: publishLive could no longer throw, so delivery
        // always looked successful and this scenario silently regressed.
        const queue = new InMemoryGlobalEventQueue();
        const received: string[] = [];
        queue.subscribe((delivery) => {
            if (received.length === 0) {
                received.push("thrown");
                throw new Error("subscriber exploded");
            }
            received.push(delivery.event.type);
        });
        const tracker = createTracker({
            onLiveEvent: (event) => queue.publishLive(event),
            scan: countingScan(() => ({ insertions: 4 })),
        });

        tracker.watch(entity());
        await waitFor(() => received.length === 1);
        await tracker.refresh(entity());

        // The repository never changed, so only an undelivered snapshot can explain a second
        // delivery attempt.
        expect(received).toEqual(["thrown", "project_git_changed"]);
    });

    it("does not inflate the version while retrying an undelivered snapshot", async () => {
        let deliver = false;
        const versions: number[] = [];
        const tracker = createTracker({
            onLiveEvent: () => deliver,
            onSnapshot: (_entity, snapshot) => {
                versions.push(snapshot.version);
            },
            scan: countingScan(() => ({ insertions: 3 })),
        });

        tracker.watch(entity());
        await waitFor(() => versions.length >= 1);
        await tracker.refresh(entity());
        await tracker.refresh(entity());
        deliver = true;
        await tracker.refresh(entity());

        // Retrying the same state must reuse its version; bumping per attempt would let a failing
        // subscriber run the counter up indefinitely.
        expect(new Set(versions).size).toBe(1);
    });

    it("republishes after an observer throws instead of going quiet forever", async () => {
        let insertions = 1;
        let failNext = true;
        const published: GitChangeSnapshot[] = [];
        const tracker = createTracker({
            onLiveEvent: () => {
                if (!failNext) return true;
                failNext = false;
                throw new Error("subscriber exploded");
            },
            onSnapshot: (_entity, snapshot) => {
                published.push(snapshot);
            },
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

    it("stops instead of reporting when the observer fails on the database", async () => {
        const databaseError = await captureDriverError();
        let failing = false;
        const reported: unknown[] = [];
        const scan = countingScan(() => ({ insertions: failing ? 7 : 1 }));
        const tracker = createTracker({
            onObserverError: (error) => reported.push(error),
            onSnapshot: () => {
                if (failing) throw databaseError;
            },
            scan,
        });

        tracker.watch(entity());
        await waitFor(() => scan.calls === 1);
        failing = true;

        // Enrichment the next scan repeats is worth reporting and retrying; a broken database is
        // not, so it leaves the tracker rather than becoming an observer warning.
        await expect(tracker.refresh(entity())).rejects.toBe(databaseError);
        expect(reported).toEqual([]);
    });

    it("follows the repository back when it returns to the last delivered state", async () => {
        let insertions = 1;
        let deliver = true;
        const tracker = createTracker({
            onLiveEvent: () => deliver,
            scan: countingScan(() => ({ insertions })),
        });

        tracker.watch(entity());
        await waitFor(() => tracker.snapshot(entity())?.insertions === 1);
        // An undelivered intermediate state, then a revert back to what clients already hold.
        deliver = false;
        insertions = 2;
        await tracker.refresh(entity());
        expect(tracker.snapshot(entity())?.insertions).toBe(2);
        insertions = 1;
        await tracker.refresh(entity());

        // Skipping the update because the scan matched what was delivered would leave the
        // undelivered intermediate pinned as the answer to every read until a third state appeared.
        expect(tracker.snapshot(entity())?.insertions).toBe(1);
        expect(tracker.liveSnapshots()[0]?.data.git.insertions).toBe(1);
    });

    it("never regresses a version after its retained counter is evicted", async () => {
        let insertions = 1;
        const published: GitChangeSnapshot[] = [];
        const tracker = createTracker({
            onSnapshot: (_entity, snapshot) => {
                published.push(snapshot);
            },
            scan: countingScan(() => ({ insertions })),
        });

        tracker.watch(entity("kept"));
        await waitFor(() => published.length === 1);
        insertions = 2;
        await tracker.refresh(entity("kept"));
        const before = published.at(-1)!.version;

        // Churn enough distinct entities to evict the retained counter of the tracked one.
        for (let index = 0; index < 600; index += 1) {
            await tracker.refresh(entity(`churn-${String(index)}`));
        }
        insertions = 3;
        await tracker.refresh(entity("kept"));

        // A client holding the earlier version would ignore every later snapshot forever.
        expect(published.at(-1)!.version).toBeGreaterThan(before);
    }, 20_000);

    it("never reissues a version after a revert followed by counter eviction", async () => {
        let insertions = 1;
        let deliver = true;
        const seen: number[] = [];
        const tracker = createTracker({
            onSnapshot: (_entity, snapshot) => {
                seen.push(snapshot.version);
            },
            onLiveEvent: () => deliver,
            scan: countingScan(() => ({ insertions })),
        });

        tracker.watch(entity("kept"));
        await waitFor(() => seen.length === 1);
        deliver = false;
        insertions = 2;
        await tracker.refresh(entity("kept"));
        const handedOut = seen.at(-1)!;
        deliver = true;
        insertions = 1;
        await tracker.refresh(entity("kept"));
        for (let index = 0; index < 600; index += 1) {
            await tracker.refresh(entity(`churn-${String(index)}`));
        }
        insertions = 3;
        await tracker.refresh(entity("kept"));

        // Deriving the floor from resettable fields let the revert erase the tracker's memory of
        // the higher version, so eviction then reissued it for different content.
        expect(seen.at(-1)!).toBeGreaterThan(handedOut);
    }, 20_000);

    it("tells subscribers about a revert to the state they were last given", async () => {
        let insertions = 1;
        let deliver = true;
        const delivered: number[] = [];
        const tracker = createTracker({
            onLiveEvent: (event) => {
                if (deliver) delivered.push(event.data.git.insertions);
                return deliver;
            },
            scan: countingScan(() => ({ insertions })),
        });

        tracker.watch(entity());
        await waitFor(() => delivered.length === 1);
        // A subscriber picks the intermediate up from the prelude even though delivery failed.
        deliver = false;
        insertions = 2;
        await tracker.refresh(entity());
        deliver = true;
        insertions = 1;
        await tracker.refresh(entity());

        // Staying silent because the scan matched the last delivered state would leave that
        // subscriber showing the intermediate until some unrelated third state appeared.
        expect(delivered).toEqual([1, 1]);
    });

    it("retries a corrective delivery that only reached some subscribers", async () => {
        let insertions = 1;
        let deliver = true;
        const attempts: number[] = [];
        const tracker = createTracker({
            onLiveEvent: (event) => {
                attempts.push(event.data.git.insertions);
                return deliver;
            },
            scan: countingScan(() => ({ insertions })),
        });

        tracker.watch(entity());
        await waitFor(() => attempts.length === 1);
        insertions = 2;
        await tracker.refresh(entity());
        // The correction back to the delivered content fails for at least one subscriber.
        deliver = false;
        insertions = 1;
        await tracker.refresh(entity());
        const beforeRetry = attempts.length;
        deliver = true;
        await tracker.refresh(entity());

        // Judging by content alone cannot tell a failed correction from a successful one, so the
        // subscriber that missed it would stay stale until an unrelated third state appeared.
        expect(attempts.length).toBeGreaterThan(beforeRetry);
        expect(attempts.at(-1)).toBe(1);
    });

    it("never reissues a version after the entity is retired and watched again", async () => {
        let insertions = 1;
        const published: GitChangeSnapshot[] = [];
        const tracker = createTracker({
            onSnapshot: (_entity, snapshot) => {
                published.push(snapshot);
            },
            scan: countingScan(() => ({ insertions })),
        });

        tracker.watch(entity("cycled"));
        await waitFor(() => published.length === 1);
        const handedOut = published.at(-1)!.version;
        tracker.unwatch(entity("cycled"));
        for (let index = 0; index < 600; index += 1) {
            await tracker.refresh(entity(`churn-${String(index)}`));
        }
        insertions = 2;
        tracker.watch(entity("cycled"));
        await waitFor(() => published.at(-1)!.insertions === 2);

        // Retirement destroys the tracker, so any version memory kept only on it is lost; the
        // client still holds the earlier number.
        expect(published.at(-1)!.version).toBeGreaterThan(handedOut);
    }, 20_000);

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

/** Uses a real driver fault so the test cannot drift from what SQLite actually throws. */
async function captureDriverError(): Promise<unknown> {
    const database = createClient({ url: "file::memory:" });
    try {
        await database.execute("select * from missing_table");
        throw new Error("Expected the driver to fail.");
    } catch (error) {
        return error;
    } finally {
        await database.close();
    }
}
