import { createTestRootContext } from "../../testing/createTestRootContext.js";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { defineModel, defineProvider } from "@slopus/rig-execution";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Agent, createNodeAgentContext } from "../../agent/index.js";
import type { FolderContext } from "../../agent/context/FolderContext.js";
import { FolderRepository } from "../../folders/FolderRepository.js";
import { migrateSessionDatabase } from "../../persistence/database/migrateSessionDatabase.js";
import { openSessionDatabase } from "../../persistence/database/openSessionDatabase.js";
import { NativeProcessManager } from "../../processes/index.js";
import {
    createEventIdFactory,
    UNSORTED_SESSION_ARCHIVE_AFTER_MS,
    type ModelCatalog,
} from "../../protocol/index.js";
import { InMemorySession, type PersistedSessionState } from "../InMemorySession.js";
import type { AgentSessionManager } from "../AgentSessionManager.js";
import { InMemorySessionStore } from "../InMemorySessionStore.js";
import { PersistentSessionStore } from "../PersistentSessionStore.js";

const ctx = createTestRootContext();
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("chats and folders", () => {
    it("hands this chat's agent the folder tree and files this chat alone", async () => {
        const folders = await createFolderRepository();
        const filed = deferred<FolderContext | undefined>();
        const first = agentSession(folders, (context) => filed.resolve(context));
        const second = agentSession(folders, () => {});

        await first.session.submit(ctx, { text: "Work out where this belongs." });
        const context = await filed.promise;
        if (context === undefined) throw new Error("Expected the agent to reach the folder tree.");
        const folder = await context.create({ name: "Media" });

        expect(await context.setCurrentChatFolder(folder.id)).toMatchObject({ id: folder.id });
        expect(first.session.snapshot().folderId).toBe(folder.id);
        expect(second.session.snapshot().folderId).toBeUndefined();
        expect((await context.list()).map((entry) => entry.name)).toEqual(["Media"]);
        expect(await context.setCurrentChatFolder(null)).toBeUndefined();
        expect(first.session.snapshot().folderId).toBeUndefined();

        first.release.resolve();
        await first.session.beginShutdown(ctx);
        await second.session.beginShutdown(ctx);
    });

    it("files a chat into a folder and takes it back out to Unsorted", async () => {
        const { databasePath, root } = await createFixture();
        const store = await openStore({ databasePath, root });
        const folder = await store.createFolder(ctx, { name: "Trip planning" });
        const session = await store.create(ctx, { cwd: root });

        expect(session.snapshot().folderId).toBeUndefined();

        const filed = await store.setSessionFolder(ctx, session.id, folder.id);

        expect(filed?.snapshot().folderId).toBe(folder.id);
        expect(filed?.summary().folderId).toBe(folder.id);
        expect((await summaryOf(store, session.id))?.folderId).toBe(folder.id);

        const unsorted = await store.setSessionFolder(ctx, session.id, null);

        expect(unsorted?.snapshot().folderId).toBeUndefined();
        expect((await summaryOf(store, session.id))?.folderId).toBeUndefined();
    });

    it("stops every retained subagent when a primary chat changes execution scope", async () => {
        const folders = await createFolderRepository();
        const stopDescendantsForContextChange = vi.fn(() => Promise.resolve(2));
        const session = new InMemorySession(createTestRootContext().named("session"), {
            agentManager: {
                stopDescendantsForContextChange,
            } as unknown as AgentSessionManager,
            createEventId: createEventIdFactory(),
            folders,
            modelCatalog: testModelCatalog(),
            request: { cwd: tmpdir() },
        });

        await session.applyScopeMove(ctx, {
            cwd: tmpdir(),
            orderKey: "a0",
            scope: { kind: "unsorted" },
            unsortedSince: 1,
        });
        await session.applyScopeMove(ctx, {
            cwd: tmpdir(),
            orderKey: "a1",
            scope: { kind: "unsorted" },
            unsortedSince: 1,
        });

        expect(stopDescendantsForContextChange).toHaveBeenCalledOnce();
        expect(stopDescendantsForContextChange).toHaveBeenCalledWith(ctx, session.id);
    });

    it("files a chat into a folder in a store that keeps its sessions in memory", async () => {
        const root = await mkdtemp(join(tmpdir(), "rig-unsorted-memory-"));
        cleanups.push(() => rm(root, { force: true, recursive: true }));
        const store = await InMemorySessionStore.open(ctx, {
            homeDirectory: root,
            workspacesDirectory: join(root, "workspaces"),
        });
        const folder = await store.createFolder(ctx, { name: "Recipes" });
        const session = await store.create(ctx, { cwd: root });

        expect(
            (await store.setSessionFolder(ctx, session.id, folder.id))?.snapshot().folderId,
        ).toBe(folder.id);
        expect(session.snapshot().folderId).toBe(folder.id);
        expect(
            (await store.setSessionFolder(ctx, session.id, null))?.snapshot().folderId,
        ).toBeUndefined();
        expect(session.snapshot().folderId).toBeUndefined();
    });

    it("revalidates folder storage when the in-memory store files an existing chat", async () => {
        const root = await mkdtemp(join(tmpdir(), "rig-folder-memory-boundary-"));
        cleanups.push(() => rm(root, { force: true, recursive: true }));
        const store = await InMemorySessionStore.open(ctx, {
            homeDirectory: root,
            workspacesDirectory: join(root, "workspaces"),
        });
        const folder = await store.createFolder(ctx, { name: "Private work" });
        const session = await store.create(ctx, { cwd: root });
        const outside = join(root, "outside");
        await mkdir(outside);
        await rm(folder.path, { recursive: true });
        await symlink(outside, folder.path, "dir");

        await expect(store.setSessionFolder(ctx, session.id, folder.id)).rejects.toThrow("storage");
        expect(session.snapshot().scope.kind).toBe("project");
    });

    it("retries an Unsorted create by identity after Rig derives its private cwd", async () => {
        const { databasePath, root } = await createFixture();
        const store = await openStore({ databasePath, root });
        const request = { cwd: root, scope: { kind: "unsorted" as const } };

        const first = await store.createWithId(ctx, "retry-unsorted", request);
        const retried = await store.createWithId(ctx, "retry-unsorted", request);

        expect(retried.id).toBe(first.id);
        expect(retried.snapshot().cwd).toBe(first.snapshot().cwd);
        expect(retried.snapshot().cwd).not.toBe(root);
    });

    it("retires folder runtimes when their own metadata or virtual ancestry changes", async () => {
        const root = await mkdtemp(join(tmpdir(), "rig-folder-context-refresh-"));
        cleanups.push(() => rm(root, { force: true, recursive: true }));
        const store = await InMemorySessionStore.open(ctx, {
            homeDirectory: root,
            workspacesDirectory: join(root, "workspaces"),
        });
        const parent = await store.createFolder(ctx, { name: "Media" });
        const child = await store.createFolder(ctx, { name: "Cuts", parentId: parent.id });
        const session = await store.create(ctx, {
            cwd: root,
            scope: { folderId: child.id, kind: "folder" },
        });
        const first = await runtimeContext(session);

        await store.updateFolder(ctx, parent.id, { name: "Films" });
        const second = await changedContext(session, first);
        await store.updateFolder(ctx, child.id, { rules: "Keep the source files." });
        const third = await changedContext(session, second);

        expect(second).not.toBe(first);
        expect(third).not.toBe(second);
        await session.beginShutdown(ctx);
    });

    it("rebuilds trusted folder instructions without retaining their stale predecessor", async () => {
        const folders = await createFolderRepository();
        const parent = await folders.createFolder(ctx, { name: "Media" });
        const child = await folders.createFolder(ctx, {
            name: "Cuts",
            parentId: parent.id,
            rules: "Use the old rule.",
        });
        const prompts: string[] = [];
        const fixture = agentSession(
            folders,
            () => {},
            (prompt) => prompts.push(prompt ?? ""),
        );
        await fixture.session.applyScopeMove(ctx, {
            cwd: child.path,
            orderKey: "a0",
            scope: { folderId: child.id, kind: "folder" },
        });
        const first = await runtimeContext(fixture.session);

        await folders.updateFolder(ctx, parent.id, { name: "Films" });
        await folders.updateFolder(ctx, child.id, { rules: "Use the new rule." });
        fixture.session.folderContextChanged();
        await changedContext(fixture.session, first);

        expect(prompts).toHaveLength(2);
        expect(prompts[0]).toContain('virtual folder "Media / Cuts"');
        expect(prompts[0]).toContain("Use the old rule.");
        expect(prompts[1]).toContain('virtual folder "Films / Cuts"');
        expect(prompts[1]).toContain("Use the new rule.");
        expect(prompts[1]).not.toContain("Use the old rule.");
        await fixture.session.beginShutdown(ctx);
    });

    it("keeps a chat in its folder when the store is opened again", async () => {
        const { databasePath, root } = await createFixture();
        const store = await openStore({ databasePath, root });
        const folder = await store.createFolder(ctx, { name: "Season one" });
        const session = await store.create(ctx, { cwd: root });
        await store.setSessionFolder(ctx, session.id, folder.id);
        await store.close(ctx);

        const reopened = await openStore({ databasePath, root });

        expect((await reopened.get(ctx, session.id))?.snapshot().folderId).toBe(folder.id);
        expect((await summaryOf(reopened, session.id))?.folderId).toBe(folder.id);
    });

    it("keeps a scope-mutation receipt across restart after later moves", async () => {
        const { databasePath, root } = await createFixture();
        const store = await openStore({ databasePath, root });
        const folder = await store.createFolder(ctx, { name: "Season one" });
        const session = await store.create(ctx, { cwd: root });
        await store.setSessionFolder(ctx, session.id, folder.id, null, "file-once");
        await store.setSessionFolder(ctx, session.id, null, null, "move-later");
        await store.close(ctx);

        const reopened = await openStore({ databasePath, root });

        expect(await reopened.sessionScopeMutationApplied(ctx, session.id, "file-once")).toBe(true);
        expect((await reopened.get(ctx, session.id))?.snapshot().scope).toEqual({
            kind: "unsorted",
        });
    });

    it("revalidates a folder's physical directory for creation and restoration", async () => {
        const { databasePath, root } = await createFixture();
        const store = await openStore({ databasePath, root });
        const folder = await store.createFolder(ctx, { name: "Private work" });
        const existing = await store.create(ctx, {
            cwd: root,
            scope: { folderId: folder.id, kind: "folder" },
        });
        const existingId = existing.id;
        const outside = join(root, "outside");
        await mkdir(outside);
        await rm(folder.path, { recursive: true });
        await symlink(outside, folder.path, "dir");

        await expect(
            store.create(ctx, {
                cwd: root,
                scope: { folderId: folder.id, kind: "folder" },
            }),
        ).rejects.toThrow("storage");
        await expect(store.fork(ctx, existingId)).rejects.toThrow("storage");
        await store.close(ctx);

        const reopened = await openStore({ databasePath, root });

        await expect(reopened.get(ctx, existingId)).rejects.toThrow("storage");
    });

    it("archives an unloaded folder chat as a terminal execution state with a durable event", async () => {
        const { databasePath, root } = await createFixture();
        const store = await openStore({ databasePath, root });
        const folder = await store.createFolder(ctx, { name: "Finished work" });
        const sessionId = (
            await store.create(ctx, {
                cwd: root,
                scope: { folderId: folder.id, kind: "folder" },
            })
        ).id;
        await store.close(ctx);

        const reopened = await openStore({ databasePath, root });
        await reopened.archiveFolder(ctx, folder.id);
        const archived = await reopened.get(ctx, sessionId);

        expect(archived?.snapshot()).toMatchObject({ archived: true, status: "archived" });
        expect(
            archived?.events
                .all()
                .some((event) => event.type === "session_archived" && event.data.archived === true),
        ).toBe(true);
        await expect(archived?.submit(ctx, { text: "Keep working." })).rejects.toThrow("archived");
    });

    it("starts the Unsorted expiry clock when a chat leaves a folder", async () => {
        const { databasePath, root } = await createFixture();
        let now = 1_700_000_000_000;
        const store = await openStore({ databasePath, now: () => now, root });
        const folder = await store.createFolder(ctx, { name: "Filed" });
        const session = await store.create(ctx, { cwd: root });
        await store.setSessionFolder(ctx, session.id, folder.id);
        await store.setSessionFolder(ctx, session.id, null);

        now += UNSORTED_SESSION_ARCHIVE_AFTER_MS * 30;
        await store.archiveExpiredUnsortedSessions(ctx);

        expect((await store.get(ctx, session.id))?.snapshot().archived).toBe(true);
    });

    it("never sweeps a chat that was created outside the folder tree", async () => {
        const { databasePath, root } = await createFixture();
        let now = 1_700_000_000_000;
        const store = await openStore({ databasePath, now: () => now, root });
        const ordinary = await store.create(ctx, { cwd: root });

        now += UNSORTED_SESSION_ARCHIVE_AFTER_MS * 30;
        await store.archiveExpiredUnsortedSessions(ctx);

        expect((await store.get(ctx, ordinary.id))?.snapshot().archived).toBe(false);
    });

    it("retires an expired Unsorted chat with its running descendants", async () => {
        const { databasePath, root } = await createFixture();
        let now = 1_700_000_000_000;
        const store = await openStore({ databasePath, now: () => now, root });
        const folder = await store.createFolder(ctx, { name: "Filed" });
        const sorted = await store.create(ctx, { cwd: root });
        await store.setSessionFolder(ctx, sorted.id, folder.id);
        const stale = await store.create(ctx, { cwd: root, scope: { kind: "unsorted" } });
        await store.saveSession(
            ctx,
            storedSession({
                agent: {
                    depth: 1,
                    description: "Read the transcript",
                    parentSessionId: stale.id,
                    rootSessionId: stale.id,
                    type: "subagent",
                },
                cwd: root,
                id: "subagent-of-a-stale-chat",
                scope: { kind: "unsorted" },
                activeRunId: "running-in-the-background",
                status: "running",
                unsortedSince: now,
            }),
        );
        await store.saveSession(
            ctx,
            storedSession({
                agent: {
                    delegatedBySessionId: stale.id,
                    depth: 1,
                    rootSessionId: "delegated-chat",
                    type: "primary",
                },
                cwd: root,
                id: "delegated-chat",
                scope: { kind: "unsorted" },
                unsortedSince: now,
            }),
        );

        now += UNSORTED_SESSION_ARCHIVE_AFTER_MS + 1;
        const fresh = await store.create(ctx, { cwd: root, scope: { kind: "unsorted" } });
        await store.archiveExpiredUnsortedSessions(ctx);

        expect((await store.get(ctx, stale.id))?.snapshot().archived).toBe(true);
        expect((await store.get(ctx, sorted.id))?.snapshot().archived).toBe(false);
        expect((await store.get(ctx, fresh.id))?.snapshot().archived).toBe(false);
        expect((await store.get(ctx, "subagent-of-a-stale-chat"))?.snapshot()).toMatchObject({
            archived: true,
            status: "archived",
        });
        expect((await store.get(ctx, "delegated-chat"))?.snapshot().archived).toBe(false);
    });

    it("drains more than one bounded Unsorted query batch across follow-up sweeps", async () => {
        const { databasePath, root } = await createFixture();
        let now = 1_700_000_000_000;
        const store = await openStore({ databasePath, now: () => now, root });
        const stale = await Promise.all(
            Array.from({ length: 105 }, () =>
                store.create(ctx, { cwd: root, scope: { kind: "unsorted" } }),
            ),
        );

        now += UNSORTED_SESSION_ARCHIVE_AFTER_MS + 1;
        while (await store.archiveExpiredUnsortedSessions(ctx)) {
            await new Promise<void>((resolve) => setImmediate(resolve));
        }

        expect(
            (
                await Promise.all(
                    stale.map(
                        async (session) => (await store.get(ctx, session.id))?.snapshot().archived,
                    ),
                )
            ).every((archived) => archived === true),
        ).toBe(true);
    });
});

/** A folder tree of its own, so a session test never depends on a whole store. */
async function createFolderRepository(): Promise<FolderRepository> {
    const root = await mkdtemp(join(tmpdir(), "rig-session-folders-"));
    const opened = await openSessionDatabase(createTestRootContext(), ":memory:");
    await migrateSessionDatabase(opened.ctx);
    cleanups.push(async () => {
        await opened.database.close(opened.ctx);
        await rm(root, { force: true, recursive: true });
    });
    return new FolderRepository({
        database: opened.database,
        foldersDirectory: join(root, "folders"),
        unsortedDirectory: join(root, "unsorted"),
    });
}
/**
 * One chat whose agent runs against a provider that never answers, so the run stays in flight while
 * the test uses the folder tree its runtime was given.
 */
function agentSession(
    folders: FolderRepository,
    onFolders: (context?: FolderContext) => void,
    onRuntimePrompt: (prompt: string | undefined) => void = () => {},
) {
    const release = deferred<void>();
    const catalog = testModelCatalog();
    const model = catalog.models[0]!;
    const provider = defineProvider({
        id: "test",
        models: [model],
        stream() {
            return {
                async *[Symbol.asyncIterator]() {
                    await release.promise;
                    throw new Error("released");
                },
                async result() {
                    throw new Error("released");
                },
            };
        },
    });
    const session = new InMemorySession(createTestRootContext().named("session"), {
        createEventId: createEventIdFactory(),
        createRuntime: (options) => {
            onFolders(options.folders);
            onRuntimePrompt(options.appendSystemPrompt);
            const processManager = new NativeProcessManager();
            const context = createNodeAgentContext(createTestRootContext().named("agent"), {
                cwd: options.cwd,
                processManager,
            });
            return {
                agent: new Agent({
                    context,
                    modelId: options.modelId ?? model.id,
                    printToConsole: false,
                    provider,
                    tools: [],
                }),
                context,
                cwd: options.cwd,
                executor: provider,
                processManager,
            };
        },
        folders,
        modelCatalog: catalog,
        request: { cwd: tmpdir(), modelId: model.id },
    });
    return { release, session };
}

function testModelCatalog(): ModelCatalog {
    const model = defineModel({
        defaultThinkingLevel: "off",
        id: "test/capable",
        name: "Capable model",
        thinkingLevels: ["off"],
    });
    return {
        defaultModelId: model.id,
        defaultProviderId: "test",
        models: [model],
        providers: [{ models: [model], providerId: "test" }],
    };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value?: T) => void } {
    let resolvePromise: (value: T | PromiseLike<T>) => void = () => {};
    const promise = new Promise<T>((resolve) => {
        resolvePromise = resolve;
    });
    return { promise, resolve: (value) => resolvePromise(value as T) };
}

async function changedContext(
    session: InMemorySession,
    previous: Awaited<ReturnType<InMemorySession["externalControlContext"]>>,
): Promise<Awaited<ReturnType<InMemorySession["externalControlContext"]>>> {
    return await vi.waitFor(async () => {
        const current = await session.externalControlContext(ctx);
        expect(current).not.toBe(previous);
        return current;
    });
}

async function runtimeContext(
    session: InMemorySession,
): Promise<Awaited<ReturnType<InMemorySession["externalControlContext"]>>> {
    return await session.externalControlContext(ctx);
}

async function createFixture(): Promise<{ databasePath: string; root: string }> {
    const root = await mkdtemp(join(tmpdir(), "rig-unsorted-"));
    cleanups.push(() => rm(root, { force: true, recursive: true }));
    return { databasePath: join(root, "sessions.sqlite"), root };
}

async function openStore(options: {
    databasePath: string;
    now?: () => number;
    root: string;
}): Promise<PersistentSessionStore> {
    const store = await PersistentSessionStore.open(ctx, {
        databasePath: options.databasePath,
        homeDirectory: options.root,
        ...(options.now === undefined ? {} : { now: options.now }),
        stateDirectory: join(options.root, "state"),
        workspacesDirectory: join(options.root, "workspaces"),
    });
    cleanups.push(async () => {
        await store.close(ctx);
    });
    return store;
}

async function summaryOf(
    store: InMemorySessionStore | PersistentSessionStore,
    sessionId: string,
): Promise<{ folderId?: string } | undefined> {
    return (await store.list(ctx)).find((summary) => summary.id === sessionId);
}

/** A chat written straight to storage, for the kinds a store never creates on its own. */
function storedSession(
    overrides: Partial<PersistedSessionState> & { cwd: string; id: string },
): PersistedSessionState {
    return {
        agent: { depth: 0, rootSessionId: overrides.id, type: "primary" },
        agentId: `agent-of-${overrides.id}`,
        ownerInstanceId: "alocalinstance00000000001",
        messages: [],
        modelId: "openai/gpt-5.5",
        models: [],
        nextTaskId: 1,
        orderKey: "a0",
        permissionMode: "workspace_write",
        providerId: "codex",
        queuedRuns: [],
        scope: { kind: "project", projectId: "project-1" },
        status: "idle",
        tasks: [],
        titleStatus: "idle",
        tools: [],
        ...overrides,
    };
}
