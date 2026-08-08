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

        first.session.submit({ text: "Work out where this belongs." });
        const context = await filed.promise;
        if (context === undefined) throw new Error("Expected the agent to reach the folder tree.");
        const folder = context.create({ name: "Media" });

        expect(context.setCurrentChatFolder(folder.id)).toMatchObject({ id: folder.id });
        expect(first.session.snapshot().folderId).toBe(folder.id);
        expect(second.session.snapshot().folderId).toBeUndefined();
        expect(context.list().map((entry) => entry.name)).toEqual(["Media"]);
        expect(context.setCurrentChatFolder(null)).toBeUndefined();
        expect(first.session.snapshot().folderId).toBeUndefined();

        first.release.resolve();
        await first.session.beginShutdown();
        await second.session.beginShutdown();
    });

    it("files a chat into a folder and takes it back out to Unsorted", async () => {
        const { databasePath, root } = await createFixture();
        const store = openStore({ databasePath, root });
        const folder = store.createFolder({ name: "Trip planning" });
        const session = store.create({ cwd: root });

        expect(session.snapshot().folderId).toBeUndefined();

        const filed = store.setSessionFolder(session.id, folder.id);

        expect(filed?.snapshot().folderId).toBe(folder.id);
        expect(filed?.summary().folderId).toBe(folder.id);
        expect(summaryOf(store, session.id)?.folderId).toBe(folder.id);

        const unsorted = store.setSessionFolder(session.id, null);

        expect(unsorted?.snapshot().folderId).toBeUndefined();
        expect(summaryOf(store, session.id)?.folderId).toBeUndefined();
    });

    it("stops every retained subagent when a primary chat changes execution scope", async () => {
        const folders = await createFolderRepository();
        const stopDescendantsForContextChange = vi.fn(() => Promise.resolve(2));
        const session = new InMemorySession({
            agentManager: {
                stopDescendantsForContextChange,
            } as unknown as AgentSessionManager,
            createEventId: createEventIdFactory(),
            folders,
            modelCatalog: testModelCatalog(),
            request: { cwd: tmpdir() },
        });

        session.applyScopeMove({
            cwd: tmpdir(),
            orderKey: "a0",
            scope: { kind: "unsorted" },
            unsortedSince: 1,
        });
        session.applyScopeMove({
            cwd: tmpdir(),
            orderKey: "a1",
            scope: { kind: "unsorted" },
            unsortedSince: 1,
        });

        expect(stopDescendantsForContextChange).toHaveBeenCalledOnce();
        expect(stopDescendantsForContextChange).toHaveBeenCalledWith(session.id);
    });

    it("files a chat into a folder in a store that keeps its sessions in memory", async () => {
        const root = await mkdtemp(join(tmpdir(), "rig-unsorted-memory-"));
        cleanups.push(() => rm(root, { force: true, recursive: true }));
        const store = new InMemorySessionStore({
            homeDirectory: root,
            workspacesDirectory: join(root, "workspaces"),
        });
        const folder = store.createFolder({ name: "Recipes" });
        const session = store.create({ cwd: root });

        expect(store.setSessionFolder(session.id, folder.id)?.snapshot().folderId).toBe(folder.id);
        expect(session.snapshot().folderId).toBe(folder.id);
        expect(store.setSessionFolder(session.id, null)?.snapshot().folderId).toBeUndefined();
        expect(session.snapshot().folderId).toBeUndefined();
    });

    it("revalidates folder storage when the in-memory store files an existing chat", async () => {
        const root = await mkdtemp(join(tmpdir(), "rig-folder-memory-boundary-"));
        cleanups.push(() => rm(root, { force: true, recursive: true }));
        const store = new InMemorySessionStore({
            homeDirectory: root,
            workspacesDirectory: join(root, "workspaces"),
        });
        const folder = store.createFolder({ name: "Private work" });
        const session = store.create({ cwd: root });
        const outside = join(root, "outside");
        await mkdir(outside);
        await rm(folder.path, { recursive: true });
        await symlink(outside, folder.path, "dir");

        expect(() => store.setSessionFolder(session.id, folder.id)).toThrow("storage");
        expect(session.snapshot().scope.kind).toBe("project");
    });

    it("retries an Unsorted create by identity after Rig derives its private cwd", async () => {
        const { databasePath, root } = await createFixture();
        const store = openStore({ databasePath, root });
        const request = { cwd: root, scope: { kind: "unsorted" as const } };

        const first = store.createWithId("retry-unsorted", request);
        const retried = store.createWithId("retry-unsorted", request);

        expect(retried.id).toBe(first.id);
        expect(retried.snapshot().cwd).toBe(first.snapshot().cwd);
        expect(retried.snapshot().cwd).not.toBe(root);
    });

    it("retires folder runtimes when their own metadata or virtual ancestry changes", async () => {
        const root = await mkdtemp(join(tmpdir(), "rig-folder-context-refresh-"));
        cleanups.push(() => rm(root, { force: true, recursive: true }));
        const store = new InMemorySessionStore({
            homeDirectory: root,
            workspacesDirectory: join(root, "workspaces"),
        });
        const parent = store.createFolder({ name: "Media" });
        const child = store.createFolder({ name: "Cuts", parentId: parent.id });
        const session = store.create({
            cwd: root,
            scope: { folderId: child.id, kind: "folder" },
        });
        const first = session.externalControlContext();

        store.updateFolder(parent.id, { name: "Films" });
        const second = await changedContext(session, first);
        store.updateFolder(child.id, { rules: "Keep the source files." });
        const third = await changedContext(session, second);

        expect(second).not.toBe(first);
        expect(third).not.toBe(second);
        await session.beginShutdown();
    });

    it("rebuilds trusted folder instructions without retaining their stale predecessor", async () => {
        const folders = await createFolderRepository();
        const parent = folders.createFolder({ name: "Media" });
        const child = folders.createFolder({
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
        fixture.session.applyScopeMove({
            cwd: child.path,
            orderKey: "a0",
            scope: { folderId: child.id, kind: "folder" },
        });
        const first = fixture.session.externalControlContext();

        folders.updateFolder(parent.id, { name: "Films" });
        folders.updateFolder(child.id, { rules: "Use the new rule." });
        fixture.session.folderContextChanged();
        await changedContext(fixture.session, first);

        expect(prompts).toHaveLength(2);
        expect(prompts[0]).toContain('virtual folder "Media / Cuts"');
        expect(prompts[0]).toContain("Use the old rule.");
        expect(prompts[1]).toContain('virtual folder "Films / Cuts"');
        expect(prompts[1]).toContain("Use the new rule.");
        expect(prompts[1]).not.toContain("Use the old rule.");
        await fixture.session.beginShutdown();
    });

    it("keeps a chat in its folder when the store is opened again", async () => {
        const { databasePath, root } = await createFixture();
        const store = openStore({ databasePath, root });
        const folder = store.createFolder({ name: "Season one" });
        const session = store.create({ cwd: root });
        store.setSessionFolder(session.id, folder.id);
        store.close();

        const reopened = openStore({ databasePath, root });

        expect(reopened.get(session.id)?.snapshot().folderId).toBe(folder.id);
        expect(summaryOf(reopened, session.id)?.folderId).toBe(folder.id);
    });

    it("keeps a scope-mutation receipt across restart after later moves", async () => {
        const { databasePath, root } = await createFixture();
        const store = openStore({ databasePath, root });
        const folder = store.createFolder({ name: "Season one" });
        const session = store.create({ cwd: root });
        store.setSessionFolder(session.id, folder.id, null, "file-once");
        store.setSessionFolder(session.id, null, null, "move-later");
        store.close();

        const reopened = openStore({ databasePath, root });

        expect(reopened.sessionScopeMutationApplied(session.id, "file-once")).toBe(true);
        expect(reopened.get(session.id)?.snapshot().scope).toEqual({ kind: "unsorted" });
    });

    it("revalidates a folder's physical directory for creation and restoration", async () => {
        const { databasePath, root } = await createFixture();
        const store = openStore({ databasePath, root });
        const folder = store.createFolder({ name: "Private work" });
        const existing = store.create({
            cwd: root,
            scope: { folderId: folder.id, kind: "folder" },
        });
        const existingId = existing.id;
        const outside = join(root, "outside");
        await mkdir(outside);
        await rm(folder.path, { recursive: true });
        await symlink(outside, folder.path, "dir");

        expect(() =>
            store.create({
                cwd: root,
                scope: { folderId: folder.id, kind: "folder" },
            }),
        ).toThrow("storage");
        expect(() => store.fork(existingId)).toThrow("storage");
        store.close();

        const reopened = openStore({ databasePath, root });

        expect(() => reopened.get(existingId)).toThrow("storage");
    });

    it("archives an unloaded folder chat as a terminal execution state with a durable event", async () => {
        const { databasePath, root } = await createFixture();
        const store = openStore({ databasePath, root });
        const folder = store.createFolder({ name: "Finished work" });
        const sessionId = store.create({
            cwd: root,
            scope: { folderId: folder.id, kind: "folder" },
        }).id;
        store.close();

        const reopened = openStore({ databasePath, root });
        reopened.archiveFolder(folder.id);
        const archived = reopened.get(sessionId);

        expect(archived?.snapshot()).toMatchObject({ archived: true, status: "archived" });
        expect(
            archived?.events
                .all()
                .some((event) => event.type === "session_archived" && event.data.archived === true),
        ).toBe(true);
        expect(() => archived?.submit({ text: "Keep working." })).toThrow("archived");
    });

    it("starts the Unsorted expiry clock when a chat leaves a folder", async () => {
        const { databasePath, root } = await createFixture();
        let now = 1_700_000_000_000;
        const store = openStore({ databasePath, now: () => now, root });
        const folder = store.createFolder({ name: "Filed" });
        const session = store.create({ cwd: root });
        store.setSessionFolder(session.id, folder.id);
        store.setSessionFolder(session.id, null);

        now += UNSORTED_SESSION_ARCHIVE_AFTER_MS * 30;
        store.archiveExpiredUnsortedSessions();

        expect(store.get(session.id)?.snapshot().archived).toBe(true);
    });

    it("never sweeps a chat that was created outside the folder tree", async () => {
        const { databasePath, root } = await createFixture();
        let now = 1_700_000_000_000;
        const store = openStore({ databasePath, now: () => now, root });
        const ordinary = store.create({ cwd: root });

        now += UNSORTED_SESSION_ARCHIVE_AFTER_MS * 30;
        store.archiveExpiredUnsortedSessions();

        expect(store.get(ordinary.id)?.snapshot().archived).toBe(false);
    });

    it("retires an expired Unsorted chat with its running descendants", async () => {
        const { databasePath, root } = await createFixture();
        let now = 1_700_000_000_000;
        const store = openStore({ databasePath, now: () => now, root });
        const folder = store.createFolder({ name: "Filed" });
        const sorted = store.create({ cwd: root });
        store.setSessionFolder(sorted.id, folder.id);
        const stale = store.create({ cwd: root, scope: { kind: "unsorted" } });
        store.saveSession(
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
        store.saveSession(
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
        const fresh = store.create({ cwd: root, scope: { kind: "unsorted" } });
        store.archiveExpiredUnsortedSessions();

        expect(store.get(stale.id)?.snapshot().archived).toBe(true);
        expect(store.get(sorted.id)?.snapshot().archived).toBe(false);
        expect(store.get(fresh.id)?.snapshot().archived).toBe(false);
        expect(store.get("subagent-of-a-stale-chat")?.snapshot()).toMatchObject({
            archived: true,
            status: "archived",
        });
        expect(store.get("delegated-chat")?.snapshot().archived).toBe(false);
    });

    it("drains more than one bounded Unsorted query batch across follow-up sweeps", async () => {
        const { databasePath, root } = await createFixture();
        let now = 1_700_000_000_000;
        const store = openStore({ databasePath, now: () => now, root });
        const stale = Array.from({ length: 105 }, () =>
            store.create({ cwd: root, scope: { kind: "unsorted" } }),
        );

        now += UNSORTED_SESSION_ARCHIVE_AFTER_MS + 1;
        while (store.archiveExpiredUnsortedSessions()) {
            await new Promise<void>((resolve) => setImmediate(resolve));
        }

        expect(stale.every((session) => store.get(session.id)?.snapshot().archived === true)).toBe(
            true,
        );
    });
});

/** A folder tree of its own, so a session test never depends on a whole store. */
async function createFolderRepository(): Promise<FolderRepository> {
    const root = await mkdtemp(join(tmpdir(), "rig-session-folders-"));
    const opened = openSessionDatabase(":memory:");
    migrateSessionDatabase(opened.database);
    cleanups.push(async () => {
        opened.client.close();
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
    const session = new InMemorySession({
        createEventId: createEventIdFactory(),
        createRuntime: (options) => {
            onFolders(options.folders);
            onRuntimePrompt(options.appendSystemPrompt);
            const processManager = new NativeProcessManager();
            const context = createNodeAgentContext({ cwd: options.cwd, processManager });
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
    previous: ReturnType<InMemorySession["externalControlContext"]>,
): Promise<ReturnType<InMemorySession["externalControlContext"]>> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
        await new Promise<void>((resolve) => setImmediate(resolve));
        const current = session.externalControlContext();
        if (current !== previous) return current;
    }
    throw new Error("The folder runtime was not replaced.");
}

async function createFixture(): Promise<{ databasePath: string; root: string }> {
    const root = await mkdtemp(join(tmpdir(), "rig-unsorted-"));
    cleanups.push(() => rm(root, { force: true, recursive: true }));
    return { databasePath: join(root, "sessions.sqlite"), root };
}

function openStore(options: {
    databasePath: string;
    now?: () => number;
    root: string;
}): PersistentSessionStore {
    const store = new PersistentSessionStore({
        databasePath: options.databasePath,
        homeDirectory: options.root,
        ...(options.now === undefined ? {} : { now: options.now }),
        stateDirectory: join(options.root, "state"),
        workspacesDirectory: join(options.root, "workspaces"),
    });
    cleanups.push(async () => store.close());
    return store;
}

function summaryOf(
    store: InMemorySessionStore | PersistentSessionStore,
    sessionId: string,
): { folderId?: string } | undefined {
    return store.list().find((summary) => summary.id === sessionId);
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
