import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import type { SessionEvent } from "../../protocol/index.js";
import { GitStateTracker, type GitTrackedEntity } from "../GitStateTracker.js";
import { InMemorySessionStore } from "../../session/InMemorySessionStore.js";
import { markGitStateFromSessionEvent } from "../markGitStateFromSessionEvent.js";

const execFile = promisify(execFileCallback);
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
    await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("markGitStateFromSessionEvent", () => {
    it("marks the session's project when a tool finishes", async () => {
        const fixture = await createFixture();

        await markGitStateFromSessionEvent(
            toolExecutionEnd(fixture.sessionId),
            fixture.store,
            fixture.tracker,
        );

        expect(fixture.marked).toEqual([`project:${fixture.projectId}`]);
    });

    it("marks the project when a shell command finishes and when a run ends", async () => {
        const fixture = await createFixture();

        await markGitStateFromSessionEvent(
            {
                createdAt: 1,
                data: {} as never,
                id: "e2" as never,
                sessionId: fixture.sessionId,
                type: "shell_command_finished",
            } as SessionEvent,
            fixture.store,
            fixture.tracker,
        );
        await markGitStateFromSessionEvent(
            {
                createdAt: 1,
                data: {} as never,
                id: "e3" as never,
                sessionId: fixture.sessionId,
                type: "run_finished",
            } as SessionEvent,
            fixture.store,
            fixture.tracker,
        );

        expect(fixture.marked).toHaveLength(2);
    });

    it("ignores events that carry no filesystem activity", async () => {
        const fixture = await createFixture();

        await markGitStateFromSessionEvent(
            {
                createdAt: 1,
                data: { event: { iteration: 1, type: "inference_iteration_start" } } as never,
                id: "e4" as never,
                sessionId: fixture.sessionId,
                type: "agent_event",
            } as SessionEvent,
            fixture.store,
            fixture.tracker,
        );

        expect(fixture.marked).toEqual([]);
    });

    it("ignores an event for a session that no longer exists", async () => {
        const fixture = await createFixture();

        await markGitStateFromSessionEvent(
            toolExecutionEnd("missing-session"),
            fixture.store,
            fixture.tracker,
        );

        expect(fixture.marked).toEqual([]);
    });
});

function toolExecutionEnd(sessionId: string): SessionEvent {
    return {
        createdAt: 1,
        data: {
            event: {
                result: { display: "done", toolCallId: "c1", toolName: "Write" },
                type: "tool_execution_end",
            },
            runId: "run-1",
        },
        id: "e1",
        sessionId,
        type: "agent_event",
    } as never;
}

async function createFixture(): Promise<{
    marked: string[];
    projectId: string;
    sessionId: string;
    store: InMemorySessionStore;
    tracker: GitStateTracker;
}> {
    const root = await mkdtemp(join(tmpdir(), "rig-git-signal-"));
    const repository = join(root, "repository");
    await mkdir(repository);
    await git(repository, ["init", "--quiet", "--initial-branch=main"]);
    await git(repository, ["config", "user.email", "test@example.com"]);
    await git(repository, ["config", "user.name", "Test"]);
    await writeFile(join(repository, "seed.txt"), "seed\n");
    await git(repository, ["add", "--all"]);
    await git(repository, ["commit", "--quiet", "--message", "seed"]);

    const marked: string[] = [];
    const store = await InMemorySessionStore.open();
    const tracker = new GitStateTracker({
        // A scan is irrelevant here; what matters is that the entity was told it may have changed.
        scan: (async () => {
            throw new Error("The signal must not depend on a scan succeeding.");
        }) as never,
        tuning: { debounceMs: 10_000, maximumDebounceMs: 10_000, reconcileIntervalMs: 60_000 },
    });
    const session = await store.create({ cwd: repository });
    const projectId = session.snapshot().projectId!;
    const entity: GitTrackedEntity = { path: repository, projectId };
    tracker.watch(entity);
    const originalMark = tracker.markChanged.bind(tracker);
    tracker.markChanged = (value: GitTrackedEntity) => {
        marked.push(
            value.workspaceId === undefined
                ? `project:${value.projectId}`
                : `workspace:${value.workspaceId}`,
        );
        originalMark(value);
    };
    cleanups.push(async () => {
        tracker.dispose();
        await rm(root, { force: true, recursive: true });
    });
    return { marked, projectId, sessionId: session.snapshot().id, store, tracker };
}

async function git(cwd: string, args: readonly string[]): Promise<void> {
    await execFile("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 20_000 });
}
