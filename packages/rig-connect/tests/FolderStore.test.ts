import { describe, expect, it } from "vitest";

import { FolderStore } from "@/FolderStore.js";
import type { Folder, GlobalEvent, GlobalStreamHello } from "@/protocol.js";

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

function hello(folders: readonly Folder[], cursor = "c1"): GlobalStreamHello {
    return {
        catalog: {
            defaultModelId: "sonnet-5",
            defaultProviderId: "claude",
            models: [],
            providers: [],
        },
        cursor,
        folders,
        identity: { version: "test" },
        presence: {
            presence: {
                answerWaitMs: null,
                emoji: "🟢",
                id: "online",
                prompt: "The user is at the keyboard.",
                title: "Online",
            },
            presences: [],
            since: 0,
        },
        projects: [],
        protocolVersion: 11,
        sessions: [],
        sessionsComplete: true,
        terminalGroups: [],
        workspaces: [],
    };
}

function created(value: Folder, id = `e-${value.id}-${String(value.version)}`): GlobalEvent {
    return {
        createdAt: 1,
        data: { folder: value },
        folderId: value.id,
        id,
        type: "folder_created",
    };
}

function updated(value: Folder, id = `e-${value.id}-${String(value.version)}`): GlobalEvent {
    return {
        createdAt: 2,
        data: { folder: value },
        folderId: value.id,
        id,
        type: "folder_updated",
    };
}

/** The names in the tree, depth first, each nested level indented by a slash. */
function outline(store: FolderStore): string[] {
    const lines: string[] = [];
    const walk = (
        nodes: readonly { children: readonly never[]; name: string }[],
        depth: number,
    ) => {
        for (const node of nodes) {
            lines.push(`${"/".repeat(depth)}${node.name}`);
            walk(node.children, depth + 1);
        }
    };
    walk(store.folders() as never, 0);
    return lines;
}

describe("FolderStore", () => {
    it("nests the whole tree carried by the opening catalog", () => {
        const store = new FolderStore();

        const deltas = store.applyHello(
            hello([
                folder("media", { orderKey: "a" }),
                folder("videos", { orderKey: "a", parentId: "media" }),
                folder("stills", { orderKey: "b", parentId: "media" }),
                folder("writing", { orderKey: "b" }),
            ]),
        );

        expect(outline(store)).toEqual(["media", "/videos", "/stills", "writing"]);
        expect(deltas[0]).toMatchObject({ type: "folders_changed" });
        expect(deltas.filter((delta) => delta.type === "folder_added")).toHaveLength(4);
        expect(store.folders()[0]?.path).toBe("/work/folders/media");
    });

    it("adds a folder created live and applies a later change to it", () => {
        const store = new FolderStore();
        store.applyHello(hello([folder("media", { orderKey: "a" })]));

        const added = store.apply(created(folder("writing", { orderKey: "b" })));
        expect(added).toContainEqual({ folderId: "writing", type: "folder_added" });
        expect(outline(store)).toEqual(["media", "writing"]);

        const renamed = store.apply(
            updated(folder("writing", { name: "Notes", orderKey: "b", version: 2 })),
        );
        expect(renamed.filter((delta) => delta.type === "folder_added")).toEqual([]);
        expect(outline(store)).toEqual(["media", "Notes"]);
    });

    it("ignores a folder update that is older than what it already holds", () => {
        const store = new FolderStore();
        store.applyHello(hello([folder("media", { name: "Media", version: 4 })]));

        expect(store.apply(updated(folder("media", { name: "Stale", version: 3 })))).toEqual([]);
        expect(store.folder("media")?.name).toBe("Media");
    });

    it("reorders siblings when a move gives one a new order key", () => {
        const store = new FolderStore();
        store.applyHello(
            hello([
                folder("media", { orderKey: "a" }),
                folder("writing", { orderKey: "b" }),
                folder("travel", { orderKey: "c" }),
            ]),
        );
        expect(outline(store)).toEqual(["media", "writing", "travel"]);

        // The daemon derived this key from the drop; the client never invents one.
        store.apply(updated(folder("travel", { orderKey: "a5", version: 2 })));

        expect(outline(store)).toEqual(["media", "travel", "writing"]);
    });

    it("moves a folder under a new parent when the daemon reparents it", () => {
        const store = new FolderStore();
        store.applyHello(
            hello([folder("media", { orderKey: "a" }), folder("videos", { orderKey: "b" })]),
        );

        store.apply(updated(folder("videos", { orderKey: "a0", parentId: "media", version: 2 })));

        expect(outline(store)).toEqual(["media", "/videos"]);
    });

    it("drops an archived folder and everything the daemon archived with it", () => {
        const store = new FolderStore();
        store.applyHello(
            hello([
                folder("media", { orderKey: "a" }),
                folder("videos", { orderKey: "a", parentId: "media" }),
                folder("writing", { orderKey: "b" }),
            ]),
        );

        // Archiving a folder archives its whole subtree, one update per folder.
        store.apply(updated(folder("videos", { orderKey: "a", parentId: "media", version: 2 })));
        const deltas = [
            ...store.apply(
                updated(
                    folder("videos", {
                        archivedAt: 9,
                        orderKey: "a",
                        parentId: "media",
                        version: 3,
                    }),
                ),
            ),
            ...store.apply(updated(folder("media", { archivedAt: 9, orderKey: "a", version: 2 }))),
        ];

        expect(outline(store)).toEqual(["writing"]);
        expect(deltas).toContainEqual({ folderId: "videos", type: "folder_removed" });
        expect(deltas).toContainEqual({ folderId: "media", type: "folder_removed" });
    });

    it("keeps a folder that a catalog snapshot reports at an older version", () => {
        const store = new FolderStore();
        store.apply(created(folder("media", { name: "Media", version: 5 })));

        store.applyHello(hello([folder("media", { name: "Older", version: 4 })], "c2"));

        expect(store.folder("media")?.name).toBe("Media");
    });

    it("keeps every unrelated folder as the same object across a change", () => {
        const store = new FolderStore();
        store.applyHello(
            hello([
                folder("media", { orderKey: "a" }),
                folder("videos", { orderKey: "a", parentId: "media" }),
                folder("writing", { orderKey: "b" }),
            ]),
        );
        const before = store.folders();
        const media = before[0];
        const writing = before[1];

        store.apply(updated(folder("writing", { name: "Notes", orderKey: "b", version: 2 })));

        const after = store.folders();
        expect(after).not.toBe(before);
        expect(after[0]).toBe(media);
        expect(after[0]?.children[0]).toBe(media?.children[0]);
        expect(after[1]).not.toBe(writing);
        expect(after[1]?.name).toBe("Notes");
    });

    it("reports nothing and keeps the tree object when a snapshot changes nothing", () => {
        const store = new FolderStore();
        store.applyHello(hello([folder("media")]));
        const before = store.folders();

        expect(store.applyHello(hello([folder("media")], "c2"))).toEqual([]);
        expect(store.folders()).toBe(before);
    });

    it("draws a folder at the root while its parent is not in the tree", () => {
        const store = new FolderStore();

        store.applyHello(hello([folder("videos", { parentId: "media" })]));

        expect(outline(store)).toEqual(["videos"]);
        expect(store.folders()[0]?.parentId).toBe("media");
    });

    it("orders siblings that share an order key by their identity", () => {
        const store = new FolderStore();

        store.applyHello(
            hello([folder("writing", { orderKey: "a" }), folder("media", { orderKey: "a" })]),
        );

        expect(outline(store)).toEqual(["media", "writing"]);
    });

    it("reports the connection state a view renders while the stream is away", () => {
        const store = new FolderStore();

        expect(store.state()).toEqual({ connection: "connecting" });
        expect(store.setConnection("live")).toEqual([
            { state: { connection: "live" }, type: "folders_state_changed" },
        ]);
        expect(store.setConnection("live")).toEqual([]);
        expect(store.setConnection("reconnecting")).toEqual([
            { state: { connection: "reconnecting" }, type: "folders_state_changed" },
        ]);
    });

    it("ignores an event that is not about a folder", () => {
        const store = new FolderStore();

        expect(
            store.apply({
                createdAt: 1,
                data: { presence: undefined as never },
                id: "e1",
                type: "presence_changed",
            }),
        ).toEqual([]);
    });
});
