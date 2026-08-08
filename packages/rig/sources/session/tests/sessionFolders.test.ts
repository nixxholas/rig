import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { sql } from "drizzle-orm";

import { defineModel, defineProvider } from "@slopus/rig-execution";
import { afterEach, describe, expect, it } from "vitest";

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

    it("never sweeps a chat taken back out of a folder, which was never Unsorted", async () => {
        const { databasePath, root } = await createFixture();
        let now = 1_700_000_000_000;
        const store = openStore({ databasePath, now: () => now, root });
        const folder = store.createFolder({ name: "Filed" });
        const session = store.create({ cwd: root });
        store.setSessionFolder(session.id, folder.id);
        store.setSessionFolder(session.id, null);

        now += UNSORTED_SESSION_ARCHIVE_AFTER_MS * 30;
        store.archiveExpiredUnsortedSessions();

        expect(store.get(session.id)?.snapshot().archived).toBe(false);
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

    it("archives an Unsorted chat that ran out of time and leaves every other chat alone", async () => {
        const { databasePath, root } = await createFixture();
        let now = 1_700_000_000_000;
        const store = openStore({ databasePath, now: () => now, root });
        const folder = store.createFolder({ name: "Filed" });
        const sorted = store.create({ cwd: root });
        store.setSessionFolder(sorted.id, folder.id);
        const stale = store.create({ cwd: root });
        // Unsorted is where a chat is born. Nothing starts one yet, so the test states the fact
        // directly rather than pretending that unfiling a project chat creates one.
        markBornUnsorted(databasePath, stale.id, now);
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
            }),
        );

        now += UNSORTED_SESSION_ARCHIVE_AFTER_MS + 1;
        const fresh = store.create({ cwd: root });
        store.archiveExpiredUnsortedSessions();

        expect(store.get(stale.id)?.snapshot().archived).toBe(true);
        expect(store.get(sorted.id)?.snapshot().archived).toBe(false);
        expect(store.get(fresh.id)?.snapshot().archived).toBe(false);
        expect(store.get("subagent-of-a-stale-chat")?.snapshot().archived).toBe(false);
        expect(store.get("delegated-chat")?.snapshot().archived).toBe(false);
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
    });
}

/**
 * One chat whose agent runs against a provider that never answers, so the run stays in flight while
 * the test uses the folder tree its runtime was given.
 */
function agentSession(folders: FolderRepository, onFolders: (context?: FolderContext) => void) {
    const release = deferred<void>();
    const model = defineModel({
        defaultThinkingLevel: "off",
        id: "test/capable",
        name: "Capable model",
        thinkingLevels: ["off"],
    });
    const catalog: ModelCatalog = {
        defaultModelId: model.id,
        defaultProviderId: "test",
        models: [model],
        providers: [{ models: [model], providerId: "test" }],
    };
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

function deferred<T>(): { promise: Promise<T>; resolve: (value?: T) => void } {
    let resolvePromise: (value: T | PromiseLike<T>) => void = () => {};
    const promise = new Promise<T>((resolve) => {
        resolvePromise = resolve;
    });
    return { promise, resolve: (value) => resolvePromise(value as T) };
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
        messages: [],
        modelId: "openai/gpt-5.5",
        models: [],
        nextTaskId: 1,
        orderKey: "a0",
        permissionMode: "workspace_write",
        providerId: "codex",
        queuedRuns: [],
        status: "idle",
        tasks: [],
        titleStatus: "idle",
        tools: [],
        ...overrides,
    };
}

/**
 * States that a chat was born Unsorted.
 *
 * Nothing starts an Unsorted chat yet: a chat is created in a project or a workspace, which is why
 * unfiling one never makes it Unsorted. Until the folder tree can start a chat of its own, a test
 * that needs one writes the fact itself.
 */
function markBornUnsorted(databasePath: string, sessionId: string, since: number): void {
    const opened = openSessionDatabase(databasePath);
    try {
        opened.database.run(
            sql`UPDATE sessions SET unsorted_since_ms = ${since} WHERE id = ${sessionId}`,
        );
    } finally {
        opened.client.close();
    }
}
