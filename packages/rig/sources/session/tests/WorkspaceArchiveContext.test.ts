import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { trace, type Context as OtelContext, type Span, type Tracer } from "@opentelemetry/api";
import type { RootContext } from "@steve.kite/stdlib";
import { afterEach, describe, expect, it } from "vitest";

import { createTestRootContext } from "../../testing/createTestRootContext.js";
import { InMemorySessionStore } from "../InMemorySessionStore.js";
import { PersistentSessionStore } from "../PersistentSessionStore.js";
import type { SessionStore } from "../SessionStore.js";

const execFile = promisify(execFileCallback);
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
    await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe.each([
    {
        name: "InMemorySessionStore",
        open: (ctx: RootContext, root: string) =>
            InMemorySessionStore.open(ctx, {
                homeDirectory: join(root, "home"),
                stateDirectory: join(root, "state"),
                workspacesDirectory: join(root, "workspaces"),
            }),
    },
    {
        name: "PersistentSessionStore",
        open: (ctx: RootContext, root: string) =>
            PersistentSessionStore.open(ctx, {
                databasePath: join(root, "sessions.sqlite"),
                homeDirectory: join(root, "home"),
                stateDirectory: join(root, "state"),
                workspacesDirectory: join(root, "workspaces"),
            }),
    },
])("$name workspace archive context", ({ open }) => {
    it("returns after logical archival and owns cleanup in a finite worker span", async () => {
        const recording = recordingContext();
        const root = await mkdtemp(join(tmpdir(), "rig-workspace-archive-context-"));
        await Promise.all([
            mkdir(join(root, "home")),
            mkdir(join(root, "state")),
            mkdir(join(root, "workspaces")),
        ]);
        const repository = await createRepository(root);
        const store = await open(recording.ctx, root);
        cleanups.push(async () => {
            await store.close(createTestRootContext());
            await rm(root, { force: true, recursive: true });
        });
        const source = await store.create(recording.ctx, { cwd: repository });
        const projectId = source.snapshot().projectId;
        if (projectId === undefined) throw new Error("Expected a project-backed session.");
        const created = await store.createWorkspace(recording.ctx, projectId, {
            baseRef: "HEAD",
            name: "Archive Context",
        });
        if (created === undefined) throw new Error("Expected a managed workspace.");
        const ready = await waitForWorkspace(recording.ctx, store, projectId, created.id, "ready");
        await store.create(recording.ctx, {
            cwd: ready.path,
            workspaceId: ready.id,
        });

        const cleanupStarted = deferred<void>();
        const releaseCleanup = deferred<void>();
        cleanups.push(async () => releaseCleanup.resolve(undefined));
        const closeWorkspace = store.remoteTerminals.closeWorkspace.bind(store.remoteTerminals);
        store.remoteTerminals.closeWorkspace = async (cleanupCtx, ...args) => {
            cleanupStarted.resolve(undefined);
            await releaseCleanup.promise;
            await closeWorkspace(cleanupCtx, ...args);
        };
        recording.calls.length = 0;

        let responseStatus: string | undefined;
        await recording.ctx.span("test.workspace-archive-request", async (requestCtx) => {
            responseStatus = (
                await store.archiveWorkspace(requestCtx, projectId, ready.id, ready.version)
            )?.status;
        });
        await cleanupStarted.promise;

        const request = requiredSpan(recording.calls, "test.workspace-archive-request");
        const worker = requiredSpan(recording.calls, "rig.worker.workspace-archive-cleanup");
        expect(responseStatus).toBe("archiving");
        expect(request.ended).toBe(true);
        expect(worker.parentSpanId).toBeUndefined();
        expect(worker.ended).toBe(false);

        releaseCleanup.resolve(undefined);
        await waitForWorkspace(recording.ctx, store, projectId, ready.id, "archived");
        await waitFor(() => worker.ended);

        const workerSql = recording.calls.find(
            (call) => call.name.startsWith("rig.sql.") && call.parentSpanId === worker.spanId,
        );
        expect(workerSql).toBeDefined();
        expect(worker.ended).toBe(true);
        expect(
            recording.calls.some(
                (call) => call.name.startsWith("rig.sql.") && call.parentSpanId === request.spanId,
            ),
        ).toBe(true);
    });
});

interface RecordedSpan {
    ended: boolean;
    name: string;
    parentSpanId?: string;
    spanId: string;
}

function recordingContext(): { calls: RecordedSpan[]; ctx: RootContext } {
    const calls: RecordedSpan[] = [];
    let nextSpanId = 0;
    const tracer = {
        startSpan: (name: string, _options: unknown, parent: OtelContext) => {
            nextSpanId += 1;
            const spanId = nextSpanId.toString(16).padStart(16, "0");
            const parentSpanId = trace.getSpan(parent)?.spanContext().spanId;
            const call: RecordedSpan = {
                ended: false,
                name,
                ...(parentSpanId === undefined ? {} : { parentSpanId }),
                spanId,
            };
            calls.push(call);
            return {
                end: () => {
                    call.ended = true;
                },
                recordException: () => undefined,
                setStatus: () => undefined,
                spanContext: () => ({
                    spanId,
                    traceFlags: 1,
                    traceId: "1".repeat(32),
                }),
            } as unknown as Span;
        },
    } as unknown as Tracer;
    return { calls, ctx: createTestRootContext(tracer) };
}

function requiredSpan(calls: RecordedSpan[], name: string): RecordedSpan {
    const call = calls.find((candidate) => candidate.name === name);
    if (call === undefined) throw new Error(`Expected span ${name}.`);
    return call;
}

async function createRepository(root: string): Promise<string> {
    const repository = join(root, "repository");
    await mkdir(repository);
    await git(repository, ["init", "--initial-branch=main"]);
    await git(repository, ["config", "user.email", "rig@example.test"]);
    await git(repository, ["config", "user.name", "Rig Test"]);
    await writeFile(join(repository, "README.md"), "fixture\n");
    await git(repository, ["add", "README.md"]);
    await git(repository, ["commit", "-m", "Initial"]);
    return repository;
}

async function git(cwd: string, args: readonly string[]): Promise<void> {
    await execFile("git", ["-C", cwd, ...args], { timeout: 5_000 });
}

async function waitForWorkspace(
    ctx: RootContext,
    store: SessionStore,
    projectId: string,
    workspaceId: string,
    status: "ready" | "archived",
) {
    let result: Awaited<ReturnType<SessionStore["getWorkspace"]>> | undefined;
    await waitFor(async () => {
        result = await store.getWorkspace(ctx, projectId, workspaceId);
        return result?.status === status;
    });
    if (result === undefined) throw new Error(`Expected workspace ${workspaceId}.`);
    return result;
}

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (!(await predicate())) {
        if (Date.now() >= deadline) throw new Error("Timed out waiting for workspace cleanup.");
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
}

function deferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    const promise = new Promise<T>((resolvePromise) => {
        resolve = resolvePromise;
    });
    return { promise, resolve };
}
