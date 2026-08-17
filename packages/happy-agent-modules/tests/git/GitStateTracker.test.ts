import { createRootContext } from "@steve.kite/stdlib";
import { afterEach, describe, expect, it } from "vitest";

import { GitStateTracker, type GitChangeSnapshot } from "../../sources/git/GitStateTracker.js";
import type { GitChangeState } from "../../sources/git/types.js";
import { cleanupRoots, commitFile, createRepository, setOriginMain } from "./helpers.js";

const trackers: GitStateTracker[] = [];
afterEach(() => {
    for (const tracker of trackers.splice(0)) tracker.dispose();
    return cleanupRoots();
});

describe("GitStateTracker", () => {
    it("coalesces bursts, publishes changes only, and keeps versions monotonic", async () => {
        const root = createRootContext();
        const caller = root.named("test-caller");
        let insertions = 1;
        let calls = 0;
        const published: GitChangeSnapshot[] = [];
        const tracker = new GitStateTracker({
            onSnapshot: (_ctx, _entity, snapshot) => {
                published.push(snapshot);
            },
            rootContext: root,
            runGit: async () => ({
                stdout: "/tmp/repo/.git\n/tmp/repo/.git\n",
                stdoutBytes: Buffer.alloc(0),
                truncated: false,
            }),
            scan: async () => {
                calls += 1;
                return state(insertions);
            },
            tuning: { debounceMs: 1, maximumDebounceMs: 5, reconcileIntervalMs: 60_000 },
            watch: () => () => {},
        });
        trackers.push(tracker);
        const entity = { path: "/tmp/repo", projectId: "project-1" };
        tracker.watch(caller, entity);
        for (let index = 0; index < 20; index += 1) tracker.markChanged(caller, entity);
        await waitFor(() => published.length === 1);
        expect(calls).toBe(1);
        await tracker.refresh(caller, entity);
        expect(published).toHaveLength(1);
        insertions = 2;
        await tracker.refresh(caller, entity);
        expect(published.map((snapshot) => snapshot.version)).toEqual([1, 2]);
    });

    it("threads its configured runner into the default scanner", async () => {
        const repository = await createRepository();
        const head = await commitFile(repository, "tracked.txt", "one\n");
        await setOriginMain(repository, head);
        const root = createRootContext();
        const tracker = new GitStateTracker({
            rootContext: root,
            runGit: async () => {
                throw new Error("tracker runner refused");
            },
            tuning: { debounceMs: 1, maximumDebounceMs: 5, reconcileIntervalMs: 60_000 },
            watch: () => () => {},
        });
        trackers.push(tracker);

        await expect(
            tracker.refresh(root.named("test-caller"), {
                path: repository,
                projectId: "project-1",
            }),
        ).resolves.toMatchObject({
            comparison: "unavailable",
            error: "tracker runner refused",
        });
    });

    it("retries a snapshot whose durable observer failed", async () => {
        const root = createRootContext();
        let attempts = 0;
        const errors: unknown[] = [];
        const tracker = new GitStateTracker({
            onObserverError: (_ctx, error) => errors.push(error),
            onSnapshot: () => {
                attempts += 1;
                if (attempts === 1) throw new Error("persistence failed");
            },
            rootContext: root,
            runGit: async () => ({
                stdout: "/tmp/repo/.git\n/tmp/repo/.git\n",
                stdoutBytes: Buffer.alloc(0),
                truncated: false,
            }),
            scan: async () => state(1),
            tuning: { debounceMs: 1, maximumDebounceMs: 5, reconcileIntervalMs: 60_000 },
            watch: () => () => {},
        });
        trackers.push(tracker);
        const caller = root.named("test-caller");
        const entity = { path: "/tmp/repo", projectId: "project-1" };

        tracker.watch(caller, entity);
        await waitFor(() => attempts === 1);
        await tracker.refresh(caller, entity);

        expect(attempts).toBe(2);
        expect(errors).toHaveLength(1);
    });
});

function state(insertions: number): GitChangeState {
    return {
        changedFiles: 1,
        comparison: "ready",
        conflicted: false,
        countsExact: true,
        deletions: 0,
        facts: { ahead: 0, behind: 0, detached: false },
        files: [],
        filesTruncated: false,
        insertions,
        scannedAt: 1,
    };
}

async function waitFor(predicate: () => boolean): Promise<void> {
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("Timed out waiting for tracker.");
}
