import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { InMemorySessionStore } from "../../rig/sources/session/InMemorySessionStore.js";
import { createProtocolHttpServer } from "../../rig/sources/server/createProtocolHttpServer.js";
import { connectRig, FolderRequestError, type RigConnection } from "@/connectRig.js";
import type { FolderNode } from "@/FolderElement.js";

/**
 * These run against the real daemon rather than scripted frames, because the point of the library
 * is that the stream and the opening catalog alone are enough to hold the tree.
 */

const started: { close: () => Promise<void> }[] = [];

afterEach(async () => {
    for (const cleanup of started.splice(0)) await cleanup.close();
});

async function startDaemon(): Promise<{ endpoint: string; store: InMemorySessionStore }> {
    // Folders own real directories, so the daemon is pointed at a temporary home for the test.
    const home = await mkdtemp(join(tmpdir(), "rig-connect-folders-"));
    const store = new InMemorySessionStore({ homeDirectory: home });
    const server = createProtocolHttpServer({ store, token: "secret" });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const { port } = server.address() as AddressInfo;
    started.push({
        close: async () => {
            await new Promise<void>((resolve) => server.close(() => resolve()));
            await rm(home, { force: true, recursive: true });
        },
    });
    return { endpoint: `http://127.0.0.1:${port}`, store };
}

async function waitFor(predicate: () => boolean, description: string): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Timed out waiting for ${description}.`);
}

async function withRig(
    endpoint: string,
    test: (rig: RigConnection) => Promise<void>,
): Promise<void> {
    const rig = connectRig({ endpoint, token: "secret" });
    try {
        await test(rig);
    } finally {
        rig.close();
    }
}

/** The names in the tree, depth first, each nested level indented by a slash. */
function outline(folders: readonly FolderNode[], depth = 0): string[] {
    return folders.flatMap((node) => [
        `${"/".repeat(depth)}${node.name}`,
        ...outline(node.children, depth + 1),
    ]);
}

describe("rig-connect folders against a live daemon", () => {
    it("hands a subscribing view the whole tree the daemon already holds", async () => {
        const { endpoint, store } = await startDaemon();
        const media = store.createFolder({ name: "Media" });
        store.createFolder({ name: "Videos", parentId: media.id });
        store.createFolder({ name: "Writing" });

        await withRig(endpoint, async (rig) => {
            const folders = rig.connectFolders({ onChange: () => undefined });
            await waitFor(() => folders.state().connection === "live", "the stream to open");

            expect(outline(folders.folders())).toEqual(["Media", "/Videos", "Writing"]);
            expect(folders.folders()[0]?.path).toBe(store.getFolder(media.id)?.path);
            folders.close();
        });
    });

    it("adds a folder this client creates and applies the rename that follows", async () => {
        const { endpoint } = await startDaemon();

        await withRig(endpoint, async (rig) => {
            const folders = rig.connectFolders({ onChange: () => undefined });
            await waitFor(() => folders.state().connection === "live", "the stream to open");

            const created = await rig.folders.create({ icon: "🎬", name: "Media" });
            await waitFor(() => folders.folders().length === 1, "the created folder to arrive");
            expect(folders.folders()[0]).toMatchObject({
                icon: "🎬",
                id: created.id,
                name: "Media",
            });

            const renamed = await rig.folders.update(created.id, {
                description: "Where the videos live.",
                name: "Media production",
            });
            expect(renamed.version).toBeGreaterThan(created.version);
            await waitFor(
                () => folders.folders()[0]?.name === "Media production",
                "the rename to arrive",
            );
            expect(folders.folders()[0]?.description).toBe("Where the videos live.");
            folders.close();
        });
    });

    it("reorders siblings from a drop the daemon turns into an order key", async () => {
        const { endpoint } = await startDaemon();

        await withRig(endpoint, async (rig) => {
            const folders = rig.connectFolders({ onChange: () => undefined });
            await waitFor(() => folders.state().connection === "live", "the stream to open");

            const media = await rig.folders.create({ name: "Media" });
            await rig.folders.create({ name: "Writing" });
            const travel = await rig.folders.create({ name: "Travel" });
            await waitFor(() => folders.folders().length === 3, "all three folders to arrive");
            expect(outline(folders.folders())).toEqual(["Media", "Writing", "Travel"]);

            // Dropped into the root, directly below Media. Rig derives the key from that pair.
            const moved = await rig.folders.move(travel.id, {
                afterId: media.id,
                parentId: null,
            });
            expect(moved.orderKey).not.toBe(travel.orderKey);
            await waitFor(
                () => outline(folders.folders()).join() === ["Media", "Travel", "Writing"].join(),
                "the move to reorder the siblings",
            );

            // And dropped inside Media, where it becomes the only child.
            await rig.folders.move(travel.id, { afterId: null, parentId: media.id });
            await waitFor(
                () => outline(folders.folders()).join() === ["Media", "/Travel", "Writing"].join(),
                "the move to renest the folder",
            );
            expect(folders.folders()[0]?.children[0]?.parentId).toBe(media.id);
            folders.close();
        });
    });

    it("takes an archived folder and its children out of the tree", async () => {
        const { endpoint } = await startDaemon();

        await withRig(endpoint, async (rig) => {
            const removed: string[] = [];
            const folders = rig.connectFolders({
                onChange: () => undefined,
                onDelta: (delta) => {
                    if (delta.type === "folder_removed") removed.push(delta.folderId);
                },
            });
            await waitFor(() => folders.state().connection === "live", "the stream to open");

            const media = await rig.folders.create({ name: "Media" });
            const videos = await rig.folders.create({ name: "Videos", parentId: media.id });
            await rig.folders.create({ name: "Writing" });
            await waitFor(() => outline(folders.folders()).length === 3, "the folders to arrive");

            const archived = await rig.folders.archive(media.id);
            expect(archived.archivedAt).toBeGreaterThan(0);
            await waitFor(
                () => outline(folders.folders()).join() === "Writing",
                "the archived subtree to leave the tree",
            );
            expect(removed.sort()).toEqual([media.id, videos.id].sort());
            folders.close();
        });
    });

    it("carries a filed chat's folder to the catalog and to the chat's own state", async () => {
        const { endpoint, store } = await startDaemon();
        const session = store.create({ cwd: "/tmp/rig-connect-folders" });
        const folder = store.createFolder({ name: "Trip planning" });

        await withRig(endpoint, async (rig) => {
            const groups = rig.connectGroups({ onChange: () => undefined });
            const chat = rig.connectSession({
                onChange: () => undefined,
                sessionId: session.id,
            });
            await waitFor(() => groups.state().connection === "live", "the catalog to load");
            await waitFor(() => chat.session().sessionId === session.id, "the chat to load");

            store.setSessionFolder(session.id, folder.id);
            await waitFor(
                () =>
                    groups
                        .projects()
                        .flatMap((project) => project.sessions)
                        .some((candidate) => candidate.folderId === folder.id),
                "the chat's folder to reach the catalog",
            );
            await waitFor(
                () => chat.session().folderId === folder.id,
                "the chat's folder to reach its own state",
            );

            store.setSessionFolder(session.id, null);
            await waitFor(
                () => chat.session().folderId === undefined,
                "the chat to return to Unsorted",
            );

            chat.close();
            groups.close();
        });
    });

    it("files a chat into a folder through the connection", async () => {
        const { endpoint, store } = await startDaemon();
        const session = store.create({ cwd: "/tmp/rig-connect-folders" });

        await withRig(endpoint, async (rig) => {
            const folder = await rig.folders.create({ name: "Trip planning" });
            await rig.folders.setSessionFolder(session.id, folder.id);
            expect(store.list().find((summary) => summary.id === session.id)?.folderId).toBe(
                folder.id,
            );
        });
    });

    it("refuses a folder change with the daemon's own code and message", async () => {
        const { endpoint } = await startDaemon();

        await withRig(endpoint, async (rig) => {
            const media = await rig.folders.create({ name: "Media" });
            const videos = await rig.folders.create({ name: "Videos", parentId: media.id });

            await expect(
                rig.folders.move(media.id, { afterId: null, parentId: videos.id }),
            ).rejects.toMatchObject({ code: "cycle", name: "FolderRequestError", status: 400 });
            await expect(rig.folders.archive("not-a-folder")).rejects.toMatchObject({
                code: "folder_not_found",
                name: "FolderRequestError",
                status: 404,
            });
            await expect(rig.folders.create({ name: "  " })).rejects.toBeInstanceOf(
                FolderRequestError,
            );
        });
    });

    it("loads the tree for a folder view that opens after the catalog already did", async () => {
        const { endpoint, store } = await startDaemon();
        store.createFolder({ name: "Media" });

        await withRig(endpoint, async (rig) => {
            const groups = rig.connectGroups({ onChange: () => undefined });
            await waitFor(() => groups.state().connection === "live", "the catalog to load");

            const folders = rig.connectFolders({ onChange: () => undefined });
            await waitFor(
                () => outline(folders.folders()).join() === "Media",
                "the tree to reach a view that subscribed late",
            );

            folders.close();
            groups.close();
        });
    });

    it("keeps the catalog loaded for a folder view with nothing else subscribed", async () => {
        const { endpoint, store } = await startDaemon();

        await withRig(endpoint, async (rig) => {
            const folders = rig.connectFolders({ onChange: () => undefined });
            await waitFor(() => folders.state().connection === "live", "the stream to open");

            store.createFolder({ name: "Media" });
            await waitFor(
                () => folders.folders().length === 1,
                "a folder created outside this client to arrive",
            );
            folders.close();
        });
    });
});
