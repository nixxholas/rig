import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createRootContext, type Context } from "@steve.kite/stdlib";
import { afterEach, describe, expect, it } from "vitest";

import { GitModule } from "../../sources/git/GitModule.js";
import type { GitCommandRunner } from "../../sources/git/GitCommandRunner.js";
import type { GitChangeSnapshot } from "../../sources/git/types.js";
import { cleanupRoots, commitFile, createRepository, gitRunner, setOriginMain } from "./helpers.js";

const modules: GitModule[] = [];
afterEach(() => {
    for (const module of modules.splice(0)) module.dispose();
    return cleanupRoots();
});

function open(runner: GitCommandRunner = gitRunner): GitModule {
    const module = GitModule.withRunner(runner);
    modules.push(module);
    return module;
}

function caller(): Context {
    return createRootContext().named("test-caller");
}

describe("GitModule live tracking", () => {
    it("coalesces a burst, publishes changes only, and keeps versions monotonic", async () => {
        const repository = await createRepository();
        const head = await commitFile(repository, "tracked.txt", "one\n");
        await setOriginMain(repository, head);
        const module = open();
        const published: GitChangeSnapshot[] = [];
        module.onSnapshot((_ctx, _entity, snapshot) => {
            published.push(snapshot);
        });
        const entity = { path: repository, projectId: "project-1" };

        module.track(entity);
        for (let index = 0; index < 20; index += 1) module.markChanged(entity);
        await waitFor(() => published.length === 1);

        // Nothing changed in the repository, so a rescan publishes nothing new.
        await module.refresh(caller(), entity);
        expect(published).toHaveLength(1);
        expect(module.trackedSnapshot(entity)?.version).toBe(published[0]?.version);
        expect(module.trackedKeys()).toEqual(["project:project-1"]);
        expect(module.liveSnapshots()).toMatchObject([
            { projectId: "project-1", type: "project_git_changed" },
        ]);

        await writeFile(join(repository, "tracked.txt"), "two\n");
        await module.refresh(caller(), entity);
        await waitFor(() => published.length >= 2);
        const versions = published.map((snapshot) => snapshot.version);
        expect(versions).toEqual([...versions].sort((left, right) => left - right));
        expect(new Set(versions).size).toBe(versions.length);
        expect(published.at(-1)?.changedFiles).toBeGreaterThan(0);
    });

    it("keeps a snapshot pending when a subscriber could not take it", async () => {
        const repository = await createRepository();
        const head = await commitFile(repository, "tracked.txt", "one\n");
        await setOriginMain(repository, head);
        const module = open();
        let attempts = 0;
        module.onSnapshot(() => {
            attempts += 1;
            if (attempts === 1) throw new Error("persistence failed");
        });
        const entity = { path: repository, projectId: "project-1" };

        module.track(entity);
        await waitFor(() => attempts === 1);
        await module.refresh(caller(), entity);

        expect(attempts).toBeGreaterThanOrEqual(2);
    });

    it("stops publishing once a repository is no longer tracked", async () => {
        const repository = await createRepository();
        const head = await commitFile(repository, "tracked.txt", "one\n");
        await setOriginMain(repository, head);
        const module = open();
        let published = 0;
        const unsubscribe = module.onSnapshot(() => {
            published += 1;
        });
        const entity = { path: repository, projectId: "project-1" };

        module.track(entity);
        await waitFor(() => published === 1);
        module.untrack(entity);
        expect(module.trackedKeys()).toEqual([]);
        expect(module.trackedSnapshot(entity)).toBeUndefined();

        unsubscribe();
        module.track(entity);
        await module.refresh(caller(), entity);
        expect(published).toBe(1);
    });

    it("reports the configured Git boundary's failure rather than scanning around it", async () => {
        const repository = await createRepository();
        const head = await commitFile(repository, "tracked.txt", "one\n");
        await setOriginMain(repository, head);
        const module = open({
            async run() {
                return { code: 3, stderr: "tracker runner refused", stdout: "" };
            },
        });

        await expect(
            module.refresh(caller(), { path: repository, projectId: "project-1" }),
        ).resolves.toMatchObject({
            comparison: "unavailable",
            error: "tracker runner refused",
        });
    });
});

async function waitFor(predicate: () => boolean): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("Timed out waiting for the Git module.");
}
