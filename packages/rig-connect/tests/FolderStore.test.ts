import { describe, expect, it } from "vitest";

import { FolderStore } from "@/FolderStore.js";
import type {
    Folder,
    FolderItem,
    GlobalEvent,
    GlobalStreamHello,
    SessionScope,
    SessionSummary,
} from "@/protocol.js";

function folder(id: string, overrides: Partial<Folder> = {}): Folder {
    return {
        createdAt: 1,
        id,
        name: id,
        orderKey: id,
        path: `/work/folders/${id}`,
        updatedAt: 1,
        version: 1,
        ...overrides,
    };
}

function session(
    id: string,
    scope: SessionScope,
    orderKey: string,
    overrides: Partial<SessionSummary> = {},
): SessionSummary {
    return {
        archived: false,
        createdAt: 1,
        cwd: "/work",
        id,
        modelId: "model",
        ownerInstanceId: "alocalinstance00000000001",
        orderKey,
        permissionMode: "auto",
        providerId: "codex",
        scope,
        status: "idle",
        titleStatus: "ready",
        updatedAt: 1,
        ...overrides,
    };
}

function hello(
    folders: readonly Folder[],
    sessions: readonly SessionSummary[] = [],
    folderItems: readonly FolderItem[] = [],
): GlobalStreamHello {
    return {
        catalog: {
            defaultModelId: "model",
            defaultProviderId: "codex",
            models: [],
            providers: [],
        },
        cursor: "c1",
        folders,
        folderItems,
        identity: { version: "test" },
        presence: {
            presence: {
                answerWaitMs: null,
                emoji: "🟢",
                id: "online",
                prompt: "Online",
                title: "Online",
            },
            presences: [],
            since: 0,
        },
        projects: [],
        protocolVersion: 17,
        sessions,
        sessionsComplete: true,
        terminalGroups: [],
        workspaces: [],
    };
}

function item(
    id: string,
    folderId: string,
    orderKey: string,
    overrides: Partial<FolderItem> = {},
): FolderItem {
    return {
        createdAt: 1,
        folderId,
        id,
        orderKey,
        target: { kind: "project", projectId: "project-1" },
        updatedAt: 1,
        version: 1,
        ...overrides,
    };
}

function updated(value: SessionSummary): GlobalEvent {
    return {
        createdAt: 2,
        data: { session: value },
        id: "event-2",
        sessionId: value.id,
        type: "session_updated",
    };
}

function outline(store: FolderStore): string[] {
    const result: string[] = [];
    const visit = (nodes: ReturnType<FolderStore["folders"]>, depth: number): void => {
        for (const node of nodes) {
            result.push(`${"/".repeat(depth)}${node.name}`);
            visit(node.children, depth + 1);
        }
    };
    visit(store.folders(), 0);
    return result;
}

describe("FolderStore", () => {
    it("projects nested folders, their independently ordered chats, and global Unsorted", () => {
        const store = new FolderStore();
        store.applyHello(
            hello(
                [
                    folder("media", { orderKey: "a" }),
                    folder("video", { orderKey: "a", parentId: "media" }),
                ],
                [
                    session("folder-b", { folderId: "media", kind: "folder" }, "b"),
                    session("folder-a", { folderId: "media", kind: "folder" }, "a"),
                    session("unsorted-b", { kind: "unsorted" }, "b"),
                    session("unsorted-a", { kind: "unsorted" }, "a"),
                    session("project", { kind: "project", projectId: "p1" }, "a"),
                    session(
                        "workspace",
                        { kind: "workspace", projectId: "p1", workspaceId: "w1" },
                        "a",
                    ),
                ],
            ),
        );

        expect(outline(store)).toEqual(["media", "/video"]);
        expect(store.folders()[0]?.sessions.map((item) => item.id)).toEqual([
            "folder-a",
            "folder-b",
        ]);
        expect(store.unsorted().map((item) => item.id)).toEqual(["unsorted-a", "unsorted-b"]);
    });

    it("moves a streamed chat atomically between Unsorted and one folder", () => {
        const store = new FolderStore();
        const unsorted = session("chat", { kind: "unsorted" }, "a");
        store.applyHello(hello([folder("media")], [unsorted]));

        const deltas = store.apply(
            updated({ ...unsorted, scope: { folderId: "media", kind: "folder" } }),
        );

        expect(store.unsorted()).toEqual([]);
        expect(store.folders()[0]?.sessions.map((item) => item.id)).toEqual(["chat"]);
        expect(deltas.filter((delta) => delta.type === "folders_changed")).toHaveLength(1);
    });

    it("keeps unrelated folder and session references stable", () => {
        const store = new FolderStore();
        const mediaChat = session("media-chat", { folderId: "media", kind: "folder" }, "a");
        const writingChat = session("writing-chat", { folderId: "writing", kind: "folder" }, "a");
        store.applyHello(
            hello(
                [folder("media", { orderKey: "a" }), folder("writing", { orderKey: "b" })],
                [mediaChat, writingChat],
            ),
        );
        const media = store.folders()[0];
        const mediaSession = media?.sessions[0];

        store.apply(updated({ ...writingChat, title: "Changed", updatedAt: 2 }));

        expect(store.folders()[0]).toBe(media);
        expect(store.folders()[0]?.sessions[0]).toBe(mediaSession);
        expect(store.folders()[1]?.sessions[0]?.title).toBe("Changed");
    });

    it("archives a complete subtree in one optimistic frame and restores it on undo", () => {
        const store = new FolderStore();
        store.applyHello(
            hello([
                folder("media", { orderKey: "a" }),
                folder("video", { orderKey: "a", parentId: "media" }),
                folder("writing", { orderKey: "b" }),
            ]),
        );

        const changed = store.applyOptimisticArchive("media", 10);
        expect(outline(store)).toEqual(["writing"]);
        expect(changed.deltas.filter((delta) => delta.type === "folders_changed")).toHaveLength(1);

        changed.undo();
        expect(outline(store)).toEqual(["media", "/video", "writing"]);
    });

    it("preserves a newer known folder when an older snapshot arrives", () => {
        const store = new FolderStore();
        store.replaceFolders([folder("media", { name: "New", version: 4 })]);

        store.replaceFolders([folder("media", { name: "Old", version: 3 })]);

        expect(store.folder("media")?.name).toBe("New");
    });

    it("keeps an unchanged application view by reference", () => {
        const store = new FolderStore();
        store.applyHello(hello([folder("media")]));
        const before = store.view();

        expect(store.applyHello(hello([folder("media")]))).toEqual([]);
        expect(store.view()).toBe(before);
    });

    it("renders duplicate target links and orders each folder's items independently", () => {
        const store = new FolderStore();
        store.applyHello(
            hello(
                [folder("media", { orderKey: "a" }), folder("writing", { orderKey: "b" })],
                [],
                [
                    item("media-second", "media", "b"),
                    item("writing-first", "writing", "a"),
                    item("media-first", "media", "a"),
                    item("document", "writing", "b", {
                        target: { documentId: "document-1", kind: "document" },
                    }),
                ],
            ),
        );

        expect(store.folders()[0]?.items.map((value) => value.id)).toEqual([
            "media-first",
            "media-second",
        ]);
        expect(store.folders()[1]?.items.map((value) => value.id)).toEqual([
            "writing-first",
            "document",
        ]);
        expect(store.folders()[0]?.items[0]?.target).toEqual(store.folders()[0]?.items[1]?.target);
    });

    it("hides archived project and workspace targets without mutating their folder items", () => {
        const store = new FolderStore();
        const projectItem = item("project-item", "media", "a");
        const workspaceItem = item("workspace-item", "media", "b", {
            target: { kind: "workspace", workspaceId: "workspace-1" },
        });
        store.applyHello(hello([folder("media")], [], [projectItem, workspaceItem]));

        const projectDeltas = store.apply({
            createdAt: 2,
            data: { project: { archivedAt: 2, id: "project-1" } },
            id: "event-project",
            projectId: "project-1",
            type: "project_updated",
        } as unknown as GlobalEvent);

        expect(store.folders()[0]?.items.map((value) => value.id)).toEqual(["workspace-item"]);
        expect(projectDeltas).toContainEqual({
            itemId: "project-item",
            type: "item_removed",
        });
        expect(store.item("project-item")).toBe(projectItem);

        const workspaceDeltas = store.apply({
            createdAt: 3,
            data: {
                workspace: {
                    archivedAt: 3,
                    id: "workspace-1",
                    projectId: "project-1",
                },
            },
            id: "event-workspace",
            projectId: "project-1",
            type: "workspace_updated",
            workspaceId: "workspace-1",
        } as unknown as GlobalEvent);

        expect(store.folders()[0]?.items).toEqual([]);
        expect(workspaceDeltas).toContainEqual({
            itemId: "workspace-item",
            type: "item_removed",
        });
        expect(store.item("workspace-item")).toBe(workspaceItem);
    });

    it("moves and archives items optimistically, restoring each mutation on undo", () => {
        const store = new FolderStore();
        store.applyHello(
            hello(
                [folder("media", { orderKey: "a" }), folder("writing", { orderKey: "b" })],
                [],
                [item("first", "media", "a"), item("second", "media", "b")],
            ),
        );

        const move = store.applyOptimisticItemMove("second", "writing", null);
        expect(store.folders()[0]?.items.map((value) => value.id)).toEqual(["first"]);
        expect(store.folders()[1]?.items.map((value) => value.id)).toEqual(["second"]);
        move.undo();
        expect(store.folders()[0]?.items.map((value) => value.id)).toEqual(["first", "second"]);

        const archive = store.applyOptimisticItemArchive("second", 2);
        expect(store.folders()[0]?.items.map((value) => value.id)).toEqual(["first"]);
        archive.undo();
        expect(store.folders()[0]?.items.map((value) => value.id)).toEqual(["first", "second"]);
    });

    it("keeps unrelated folder item references stable", () => {
        const store = new FolderStore();
        const media = item("media", "media", "a");
        const writing = item("writing", "writing", "a");
        store.applyHello(
            hello(
                [folder("media", { orderKey: "a" }), folder("writing", { orderKey: "b" })],
                [],
                [media, writing],
            ),
        );
        const mediaNode = store.folders()[0];
        const mediaItem = mediaNode?.items[0];

        store.applyItem({
            ...writing,
            target: { workspaceId: "workspace-1", kind: "workspace" },
            version: 2,
        });

        expect(store.folders()[0]).toBe(mediaNode);
        expect(store.folders()[0]?.items[0]).toBe(mediaItem);
    });
});
