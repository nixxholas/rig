import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { InMemorySessionStore } from "../../rig/sources/session/InMemorySessionStore.js";
import { createProtocolHttpServer } from "../../rig/sources/server/createProtocolHttpServer.js";
import { connectRig, type RigConnection } from "@/connectRig.js";

const started: { close: () => Promise<void> }[] = [];

afterEach(async () => {
    for (const cleanup of started.splice(0)) await cleanup.close();
});

async function startDaemon(): Promise<{ endpoint: string; store: InMemorySessionStore }> {
    const home = await mkdtemp(join(tmpdir(), "rig-connect-folders-"));
    const store = await InMemorySessionStore.open({ homeDirectory: home });
    const server = await createProtocolHttpServer({ store, token: "secret" });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const { port } = server.address() as AddressInfo;
    started.push({
        close: async () => {
            await new Promise<void>((resolve) => server.close(() => resolve()));
            await store.close();
            await rm(home, { force: true, recursive: true });
        },
    });
    return { endpoint: `http://127.0.0.1:${port}`, store };
}

async function waitFor(
    predicate: () => boolean | Promise<boolean>,
    description: string,
): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
        if (await predicate()) return;
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

describe("rig-connect folder and Unsorted projections against a live daemon", () => {
    it("applies folder changes immediately", async () => {
        const { endpoint } = await startDaemon();
        await withRig(endpoint, async (rig) => {
            const connection = rig.connectFolders({ onChange: () => undefined });
            await waitFor(() => connection.state().connection === "live", "the catalog to load");

            const mediaId = rig.folders.create({ name: "Media" });
            expect(connection.view().folders.map((folder) => folder.id)).toEqual([mediaId]);

            rig.folders.update(mediaId, { name: "Production" });
            expect(connection.view().folders[0]?.name).toBe("Production");
            connection.close();
        });
    });

    it("never duplicates folder or Unsorted chats in project/workspace groups", async () => {
        const { endpoint, store } = await startDaemon();
        const folder = await store.createFolder({ name: "Trips" });
        const projectChat = await store.create({ cwd: "/tmp/rig-connect-folder-project" });
        const folderChat = await store.create({
            cwd: folder.path,
            scope: { folderId: folder.id, kind: "folder" },
        });
        const unsortedChat = await store.create({
            cwd: "/tmp",
            scope: { kind: "unsorted" },
        });

        await withRig(endpoint, async (rig) => {
            const groups = rig.connectGroups({ onChange: () => undefined });
            const folders = rig.connectFolders({ onChange: () => undefined });
            await waitFor(() => groups.state().connection === "live", "the catalog to load");

            expect(
                groups
                    .projects()
                    .flatMap((project) => [
                        ...project.sessions,
                        ...project.workspaces.flatMap((workspace) => workspace.sessions),
                    ])
                    .map((session) => session.id),
            ).toContain(projectChat.id);
            expect(
                groups
                    .projects()
                    .flatMap((project) => [
                        ...project.sessions,
                        ...project.workspaces.flatMap((workspace) => workspace.sessions),
                    ])
                    .map((session) => session.id),
            ).not.toEqual(expect.arrayContaining([folderChat.id, unsortedChat.id]));
            expect(folders.view().folders[0]?.sessions.map((session) => session.id)).toEqual([
                folderChat.id,
            ]);
            expect(folders.view().unsorted.map((session) => session.id)).toEqual([unsortedChat.id]);

            folders.close();
            groups.close();
        });
    });

    it("moves a chat between Unsorted and a folder in one optimistic frame", async () => {
        const { endpoint, store } = await startDaemon();
        const folder = await store.createFolder({ name: "Trips" });
        const chat = await store.create({ cwd: "/tmp", scope: { kind: "unsorted" } });

        await withRig(endpoint, async (rig) => {
            const folders = rig.connectFolders({ onChange: () => undefined });
            await waitFor(() => folders.state().connection === "live", "the catalog to load");

            rig.folders.setSessionFolder(chat.id, folder.id);

            expect(folders.view().unsorted).toEqual([]);
            expect(folders.view().folders[0]?.sessions.map((session) => session.id)).toEqual([
                chat.id,
            ]);
            await waitFor(
                async () =>
                    (await store.list()).find((session) => session.id === chat.id)?.scope.kind ===
                    "folder",
                "the authoritative session scope",
            );
            folders.close();
        });
    });

    it("publishes cross-tree moves only after both projections agree", async () => {
        const { endpoint, store } = await startDaemon();
        const folder = await store.createFolder({ name: "Trips" });
        const chat = await store.create({ cwd: "/tmp/rig-connect-folder-project" });

        await withRig(endpoint, async (rig) => {
            let monitoring = false;
            const observedMembershipCounts: number[] = [];
            const folders = rig.connectFolders({
                onChange: () => {
                    if (!monitoring) return;
                    const folderCount = folders
                        .view()
                        .folders.flatMap((item) => item.sessions)
                        .filter((session) => session.id === chat.id).length;
                    observedMembershipCounts.push(folderCount + groupMembershipCount());
                },
            });
            let groups = rig.connectGroups({
                onChange: () => {
                    if (!monitoring) return;
                    const folderCount = folders
                        .view()
                        .folders.flatMap((item) => item.sessions)
                        .filter((session) => session.id === chat.id).length;
                    observedMembershipCounts.push(folderCount + groupMembershipCount());
                },
            });
            const groupMembershipCount = (): number =>
                groups
                    .projects()
                    .flatMap((project) => [
                        ...project.sessions,
                        ...project.workspaces.flatMap((workspace) => workspace.sessions),
                    ])
                    .filter((session) => session.id === chat.id).length;
            await waitFor(
                () => groups.state().connection === "live" && folders.state().connection === "live",
                "both catalogs to load",
            );

            monitoring = true;
            rig.folders.setSessionFolder(chat.id, folder.id);

            expect(observedMembershipCounts.length).toBeGreaterThan(0);
            expect(observedMembershipCounts).toEqual(observedMembershipCounts.map(() => 1));
            folders.close();
            groups.close();
        });
    });

    it("reorders chats only within their current folder", async () => {
        const { endpoint, store } = await startDaemon();
        const folder = await store.createFolder({ name: "Trips" });
        const first = await store.create({
            cwd: "/tmp/first",
            scope: { folderId: folder.id, kind: "folder" },
        });
        const second = await store.create({
            cwd: "/tmp/second",
            scope: { folderId: folder.id, kind: "folder" },
        });

        await withRig(endpoint, async (rig) => {
            const folders = rig.connectFolders({ onChange: () => undefined });
            await waitFor(() => folders.state().connection === "live", "the catalog to load");
            expect(folders.view().folders[0]?.sessions.map((session) => session.id)).toEqual([
                first.id,
                second.id,
            ]);

            rig.folders.moveSession(second.id, {
                afterId: null,
                scope: { folderId: folder.id, kind: "folder" },
            });

            expect(folders.view().folders[0]?.sessions.map((session) => session.id)).toEqual([
                second.id,
                first.id,
            ]);
            await waitFor(async () => {
                const ordered = (await store.list())
                    .filter(
                        (session) =>
                            session.scope.kind === "folder" && session.scope.folderId === folder.id,
                    )
                    .sort((left, right) =>
                        (left.orderKey ?? "") < (right.orderKey ?? "") ? -1 : 1,
                    );
                return ordered[0]?.id === second.id;
            }, "the authoritative folder order");
            folders.close();
        });
    });

    it("marks an open chat archived in the same optimistic folder-archive frame", async () => {
        const { endpoint, store } = await startDaemon();
        const folder = await store.createFolder({ name: "Trips" });
        const chat = await store.create({
            cwd: folder.path,
            scope: { folderId: folder.id, kind: "folder" },
        });

        await withRig(endpoint, async (rig) => {
            const folders = rig.connectFolders({ onChange: () => undefined });
            const session = rig.connectSession({ onChange: () => undefined, sessionId: chat.id });
            await waitFor(
                () =>
                    folders.state().connection === "live" &&
                    session.session().connection === "live",
                "the folder and chat catalogs to load",
            );

            rig.folders.archive(folder.id);

            expect(folders.view().folders).toEqual([]);
            expect(session.session().archived).toBe(true);
            session.close();
            folders.close();
        });
    });

    it("optimistically archives an open chat without a mounted folder view", async () => {
        const { endpoint, store } = await startDaemon();
        const folder = await store.createFolder({ name: "Trips" });
        const chat = await store.create({
            cwd: folder.path,
            scope: { folderId: folder.id, kind: "folder" },
        });

        await withRig(endpoint, async (rig) => {
            const session = rig.connectSession({ onChange: () => undefined, sessionId: chat.id });
            await waitFor(
                () => session.session().connection === "live",
                "the chat catalog to load",
            );

            rig.folders.archive(folder.id);

            expect(session.session().archived).toBe(true);
            session.close();
        });
    });
});
