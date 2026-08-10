import { withDatabase } from "../../database/databaseContext.js";

import { createTestRootContext } from "../../../testing/createTestRootContext.js";

import {
    chmodSync,
    existsSync,
    mkdtempSync,
    realpathSync,
    rmSync,
    statSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createId } from "@paralleldrive/cuid2";
import type { Context } from "@steve.kite/stdlib";
import { afterEach, describe, expect, it } from "vitest";

import type { Folder, FolderErrorCode, FolderEvent } from "../../../protocol/index.js";
import { FolderError, FolderRepository } from "../../../folders/FolderRepository.js";
import { migrateSessionDatabase } from "../../database/migrateSessionDatabase.js";
import { openSessionDatabase } from "../../database/openSessionDatabase.js";
import { documents, folderItemMutations } from "../../database/schema.js";
import { recordFolderItemMutationReceipt } from "../../folderItem/folderItemMutationReceipt.js";

const opened: Awaited<Awaited<ReturnType<typeof openSessionDatabase>>>[] = [];
const directories: string[] = [];
const ctx = createTestRootContext();

afterEach(() => {
    for (const open of opened.splice(0)) open.client.close();
    for (const directory of directories.splice(0)) {
        rmSync(directory, { force: true, recursive: true });
    }
});

describe("FolderRepository", () => {
    it("creates a folder at the root with its own storage directory", async () => {
        const { repository, events, foldersDirectory } = await createRepository();

        const folder = await repository.createFolder(ctx, {
            description: "Video work",
            name: "Media",
        });

        expect(folder).toMatchObject({
            description: "Video work",
            name: "Media",
            path: join(realpathSync(foldersDirectory), folder.id),
            version: 1,
        });
        expect(folder.parentId).toBeUndefined();
        expect(existsSync(folder.path)).toBe(true);
        expect(events).toEqual([
            expect.objectContaining({
                data: { revision: 1 },
                type: "folders_changed",
            }),
        ]);
    });

    it("uses private root and child directories", async () => {
        const { foldersDirectory, repository } = await createRepository();
        chmodSync(foldersDirectory, 0o755);

        const folder = await repository.createFolder(ctx, { name: "Media" });

        expect(mode(foldersDirectory)).toBe(0o700);
        expect(mode(folder.path)).toBe(0o700);
    });

    it("refuses a symlink where a client-chosen folder directory would be", async () => {
        const { foldersDirectory, repository } = await createRepository();
        const id = createId();
        const outside = mkdtempSync(join(tmpdir(), "rig-folder-outside-"));
        directories.push(outside);
        symlinkSync(outside, join(foldersDirectory, id));

        expect(
            await failureCode(
                async () => await repository.createFolder(ctx, { id, name: "Media" }),
            ),
        ).toBe("storage_unavailable");
        expect(await repository.getFolder(ctx, id)).toBeUndefined();
    });

    it("refuses a symlink used as the configured folder storage root", async () => {
        const parent = mkdtempSync(join(tmpdir(), "rig-folder-root-parent-"));
        const outside = mkdtempSync(join(tmpdir(), "rig-folder-root-outside-"));
        directories.push(parent, outside);
        const foldersDirectory = join(parent, "folders");
        symlinkSync(outside, foldersDirectory);
        const open = await openSessionDatabase(ctx, ":memory:");
        await migrateSessionDatabase(open.ctx);
        opened.push(open);
        const repository = new FolderRepository({
            database: open.database,
            foldersDirectory,
        });

        expect(
            await failureCode(async () => await repository.createFolder(ctx, { name: "Media" })),
        ).toBe("storage_unavailable");
        expect(statSync(outside).isDirectory()).toBe(true);
    });

    it("refuses a non-directory where a client-chosen folder directory would be", async () => {
        const { foldersDirectory, repository } = await createRepository();
        const id = createId();
        writeFileSync(join(foldersDirectory, id), "not a folder");

        expect(
            await failureCode(
                async () => await repository.createFolder(ctx, { id, name: "Media" }),
            ),
        ).toBe("storage_unavailable");
        expect(await repository.getFolder(ctx, id)).toBeUndefined();
    });

    it("revalidates storage before answering an idempotent create", async () => {
        const { foldersDirectory, repository } = await createRepository();
        const folder = await repository.createFolder(ctx, { name: "Media" });
        const outside = mkdtempSync(join(tmpdir(), "rig-folder-outside-"));
        directories.push(outside);
        rmSync(folder.path, { recursive: true });
        symlinkSync(outside, join(foldersDirectory, folder.id));

        expect(
            await failureCode(
                async () => await repository.createFolder(ctx, { id: folder.id, name: "Ignored" }),
            ),
        ).toBe("storage_unavailable");
    });

    it("removes only its newly-created empty directory when folder persistence fails", async () => {
        const { database, foldersDirectory } = await createRepository();
        const id = createId();
        const repository = new FolderRepository({
            database,
            foldersDirectory,
            transaction: async <T>(
                operationCtx: Context,
                body: (ctx: Context) => Promise<T>,
            ): Promise<T> =>
                database.transaction(async (tx) => {
                    await body(withDatabase(operationCtx, tx));
                    throw new Error("The database could not commit the folder.");
                }),
        });

        await expect(repository.createFolder(ctx, { id, name: "Media" })).rejects.toThrow();
        expect(existsSync(join(foldersDirectory, id))).toBe(false);
        expect(await repository.getFolder(ctx, id)).toBeUndefined();
    });

    it("creates a folder inside a parent and refuses an unknown one", async () => {
        const { repository } = await createRepository();
        const parent = await repository.createFolder(ctx, { name: "Media" });

        const child = await repository.createFolder(ctx, { name: "Videos", parentId: parent.id });

        expect(child.parentId).toBe(parent.id);
        expect(ids(await repository.listFolders(ctx))).toEqual([parent.id, child.id]);
        expect(
            await failureCode(
                async () =>
                    await repository.createFolder(ctx, { name: "Stray", parentId: createId() }),
            ),
        ).toBe("parent_not_found");
    });

    it("refuses archived parents and archived ordering siblings", async () => {
        const { repository } = await createRepository();
        const parent = await repository.createFolder(ctx, { name: "Parent" });
        const source = await repository.createFolder(ctx, { name: "Source" });
        const archivedSibling = await repository.createFolder(ctx, { name: "Archived sibling" });
        await repository.archiveFolder(ctx, parent.id);
        await repository.archiveFolder(ctx, archivedSibling.id);

        expect(
            await failureCode(
                async () =>
                    await repository.createFolder(ctx, { name: "Child", parentId: parent.id }),
            ),
        ).toBe("parent_not_found");
        expect(
            await failureCode(
                async () =>
                    await repository.moveFolder(ctx, source.id, {
                        afterId: parent.id,
                        parentId: parent.id,
                    }),
            ),
        ).toBe("parent_not_found");
        expect(
            await failureCode(
                async () =>
                    await repository.moveFolder(ctx, source.id, {
                        afterId: archivedSibling.id,
                        parentId: null,
                    }),
            ),
        ).toBe("sibling_not_found");
    });

    it("answers a repeated client-chosen id with the folder the first attempt made", async () => {
        const { repository, events } = await createRepository();
        const id = createId();

        const first = await repository.createFolder(ctx, { id, name: "Media" });
        const second = await repository.createFolder(ctx, { id, name: "Something else" });

        expect(second).toEqual(first);
        expect(await repository.listFolders(ctx)).toHaveLength(1);
        expect(events).toHaveLength(1);
    });

    it("rejects an id that is not a cuid2 identity", async () => {
        const { repository } = await createRepository();

        expect(
            await failureCode(
                async () =>
                    await repository.createFolder(ctx, { id: "media folder", name: "Media" }),
            ),
        ).toBe("invalid_request");
    });

    it("rejects control characters in names and icons that are not one emoji", async () => {
        const { repository } = await createRepository();

        expect(
            await failureCode(
                async () => await repository.createFolder(ctx, { name: "Media\nHidden" }),
            ),
        ).toBe("invalid_request");
        expect(
            await failureCode(
                async () => await repository.createFolder(ctx, { icon: "MP", name: "Media" }),
            ),
        ).toBe("invalid_request");
        expect((await repository.createFolder(ctx, { icon: "👩🏽‍💻", name: "Media" })).icon).toBe("👩🏽‍💻");
    });

    it("orders a drop at the start, between siblings, and at the end", async () => {
        const { repository } = await createRepository();
        const first = await repository.createFolder(ctx, { name: "First" });
        const second = await repository.createFolder(ctx, { name: "Second" });
        const third = await repository.createFolder(ctx, { name: "Third" });

        const start = await repository.moveFolder(ctx, third.id, { afterId: null, parentId: null });
        expect(sortsBefore(start?.orderKey, first.orderKey)).toBe(true);
        expect(ids(await repository.listFolders(ctx))).toEqual([third.id, first.id, second.id]);

        const between = await repository.moveFolder(ctx, third.id, {
            afterId: first.id,
            parentId: null,
        });
        expect(sortsBefore(first.orderKey, between?.orderKey)).toBe(true);
        expect(sortsBefore(between?.orderKey, second.orderKey)).toBe(true);
        expect(ids(await repository.listFolders(ctx))).toEqual([first.id, third.id, second.id]);

        const end = await repository.moveFolder(ctx, third.id, {
            afterId: second.id,
            parentId: null,
        });
        expect(sortsBefore(second.orderKey, end?.orderKey)).toBe(true);
        expect(ids(await repository.listFolders(ctx))).toEqual([first.id, second.id, third.id]);
    });

    it("keeps the order key of a drop that changes nothing", async () => {
        const { repository, events } = await createRepository();
        const first = await repository.createFolder(ctx, { name: "First" });
        const second = await repository.createFolder(ctx, { name: "Second" });
        events.length = 0;

        expect(
            await repository.moveFolder(ctx, second.id, { afterId: first.id, parentId: null }),
        ).toEqual(second);
        expect(events).toHaveLength(0);
    });

    it("moves a folder between parents and keeps its storage directory", async () => {
        const { repository, events } = await createRepository();
        const media = await repository.createFolder(ctx, { name: "Media" });
        const notes = await repository.createFolder(ctx, { name: "Notes" });
        const videos = await repository.createFolder(ctx, { name: "Videos", parentId: media.id });
        events.length = 0;

        const moved = await repository.moveFolder(ctx, videos.id, {
            afterId: null,
            parentId: notes.id,
        });

        expect(moved).toMatchObject({ parentId: notes.id, path: videos.path, version: 2 });
        expect(existsSync(videos.path)).toBe(true);
        expect(ids(await repository.listFolders(ctx))).toEqual([media.id, notes.id, videos.id]);
        expect(events.map((event) => event.type)).toEqual(["folders_changed"]);
    });

    it("drops a folder from another parent into the exact place it landed", async () => {
        const { repository } = await createRepository();
        const source = await repository.createFolder(ctx, { name: "Source" });
        const target = await repository.createFolder(ctx, { name: "Target" });
        const first = await repository.createFolder(ctx, { name: "First", parentId: target.id });
        const second = await repository.createFolder(ctx, { name: "Second", parentId: target.id });
        const third = await repository.createFolder(ctx, { name: "Third", parentId: target.id });
        const arriving = await repository.createFolder(ctx, {
            name: "Arriving",
            parentId: source.id,
        });

        await repository.moveFolder(ctx, arriving.id, { afterId: first.id, parentId: target.id });

        expect(childrenOf(await repository.listFolders(ctx), target.id)).toEqual([
            first.id,
            arriving.id,
            second.id,
            third.id,
        ]);
    });

    it("drops a folder from another parent at the end of its new row", async () => {
        const { repository } = await createRepository();
        const source = await repository.createFolder(ctx, { name: "Source" });
        const target = await repository.createFolder(ctx, { name: "Target" });
        const first = await repository.createFolder(ctx, { name: "First", parentId: target.id });
        const second = await repository.createFolder(ctx, { name: "Second", parentId: target.id });
        const arriving = await repository.createFolder(ctx, {
            name: "Arriving",
            parentId: source.id,
        });

        await repository.moveFolder(ctx, arriving.id, { afterId: second.id, parentId: target.id });

        expect(childrenOf(await repository.listFolders(ctx), target.id)).toEqual([
            first.id,
            second.id,
            arriving.id,
        ]);
    });

    it("refuses a move that would put a folder inside its own subtree", async () => {
        const { repository } = await createRepository();
        const media = await repository.createFolder(ctx, { name: "Media" });
        const videos = await repository.createFolder(ctx, { name: "Videos", parentId: media.id });
        const cuts = await repository.createFolder(ctx, { name: "Cuts", parentId: videos.id });

        expect(
            await failureCode(
                async () =>
                    await repository.moveFolder(ctx, media.id, {
                        afterId: null,
                        parentId: cuts.id,
                    }),
            ),
        ).toBe("cycle");
        expect(
            await failureCode(
                async () =>
                    await repository.moveFolder(ctx, media.id, {
                        afterId: null,
                        parentId: media.id,
                    }),
            ),
        ).toBe("cycle");
        expect((await repository.getFolder(ctx, media.id))?.parentId).toBeUndefined();
        expect((await repository.getFolder(ctx, media.id))?.version).toBe(1);
    });

    it("refuses a drop below a folder that is not in the target folder", async () => {
        const { repository } = await createRepository();
        const media = await repository.createFolder(ctx, { name: "Media" });
        const notes = await repository.createFolder(ctx, { name: "Notes" });
        const videos = await repository.createFolder(ctx, { name: "Videos", parentId: media.id });

        expect(
            await failureCode(
                async () =>
                    await repository.moveFolder(ctx, notes.id, {
                        afterId: videos.id,
                        parentId: null,
                    }),
            ),
        ).toBe("sibling_not_found");
    });

    it("archives a folder together with everything nested under it", async () => {
        const { repository, events } = await createRepository();
        const media = await repository.createFolder(ctx, { name: "Media" });
        const videos = await repository.createFolder(ctx, { name: "Videos", parentId: media.id });
        const cuts = await repository.createFolder(ctx, { name: "Cuts", parentId: videos.id });
        const notes = await repository.createFolder(ctx, { name: "Notes" });
        events.length = 0;

        const archived = await repository.archiveFolder(ctx, media.id);

        expect(archived?.archivedAt).toBeDefined();
        expect((await repository.getFolder(ctx, videos.id))?.archivedAt).toBeDefined();
        expect((await repository.getFolder(ctx, cuts.id))?.archivedAt).toBeDefined();
        expect((await repository.getFolder(ctx, notes.id))?.archivedAt).toBeUndefined();
        expect(events).toEqual([
            expect.objectContaining({
                data: { revision: 5 },
                type: "folders_changed",
            }),
        ]);
    });

    it("renames a folder and clears its description", async () => {
        const { repository, events } = await createRepository();
        const media = await repository.createFolder(ctx, {
            description: "Video work",
            name: "Media",
        });
        events.length = 0;

        const updated = await repository.updateFolder(ctx, media.id, {
            description: null,
            name: "Films",
        });

        expect(updated).toMatchObject({ name: "Films", version: 2 });
        expect(updated?.description).toBeUndefined();
        expect(events.map((event) => event.type)).toEqual(["folders_changed"]);
        expect(await repository.updateFolder(ctx, createId(), { name: "Nothing" })).toBeUndefined();
    });

    it("identifies every running folder context invalidated by metadata and ancestry changes", async () => {
        const { contextChanges, repository } = await createRepository();
        const parent = await repository.createFolder(ctx, { name: "Media" });
        const child = await repository.createFolder(ctx, { name: "Cuts", parentId: parent.id });
        contextChanges.length = 0;

        await repository.updateFolder(ctx, parent.id, { rules: "Keep originals." });
        await repository.updateFolder(ctx, parent.id, { name: "Films" });
        await repository.moveFolder(ctx, parent.id, { afterId: null, parentId: null });

        expect(contextChanges).toEqual([[parent.id], [parent.id, child.id]]);
    });

    it("answers an ambiguous mutation retry after newer folder changes without replaying it", async () => {
        const { repository } = await createRepository();
        const folder = await repository.createFolder(ctx, { name: "Drafts" });
        const first = await repository.updateFolder(
            ctx,
            folder.id,
            { mutationId: "rename-drafts", name: "Cuts" },
            folder.version,
        );
        const second = await repository.updateFolder(
            ctx,
            folder.id,
            { mutationId: "rename-cuts", name: "Finals" },
            first?.version,
        );

        expect(
            await repository.updateFolder(
                ctx,
                folder.id,
                { mutationId: "rename-drafts", name: "Cuts" },
                folder.version,
            ),
        ).toEqual(second);
        expect(await repository.getFolder(ctx, folder.id)).toMatchObject({
            name: "Finals",
            version: 3,
        });

        const other = await repository.createFolder(ctx, { name: "Other" });
        expect(
            await failureCode(
                async () =>
                    await repository.updateFolder(
                        ctx,
                        other.id,
                        { mutationId: "rename-drafts", name: "Wrong" },
                        other.version,
                    ),
            ),
        ).toBe("invalid_request");
    });

    it("does not advance or publish an update that changes no folder fields", async () => {
        const { events, repository } = await createRepository();
        const folder = await repository.createFolder(ctx, {
            description: "Video work",
            name: "Media",
        });
        events.length = 0;

        const unchanged = await repository.updateFolder(ctx, folder.id, {
            description: "Video work",
            name: " Media ",
        });

        expect(unchanged).toEqual(folder);
        expect(events).toEqual([]);
    });

    it("links duplicate targets in folder-local order and unlinks without touching the target", async () => {
        const { database, repository } = await createRepository();
        const source = await repository.createFolder(ctx, { name: "Source" });
        const target = await repository.createFolder(ctx, { name: "Target" });
        const documentId = createId();
        await database
            .insert(documents)
            .values({
                createdAtMs: 1,
                createdByInstanceId: "alocalinstance00000000001",
                firstRetainedVersion: 2,
                id: documentId,
                mimeType: "application/x-board",
                stateJson: "{}",
                updatedAtMs: 1,
                version: 1,
            })
            .run();
        const first = await repository.createFolderItem(ctx, source.id, {
            id: createId(),
            mutationId: "link-first",
            target: { documentId, kind: "document" },
        });
        const second = await repository.createFolderItem(ctx, source.id, {
            id: createId(),
            mutationId: "link-second",
            target: { documentId, kind: "document" },
        });

        expect((await repository.folderCatalog(ctx)).items.map((item) => item.id)).toEqual([
            first.id,
            second.id,
        ]);
        const moved = await repository.moveFolderItem(
            ctx,
            second.id,
            { afterId: null, folderId: target.id, mutationId: "move-second" },
            second.version,
        );
        expect(moved).toMatchObject({ folderId: target.id, orderKey: "a0", version: 2 });

        const archived = await repository.archiveFolderItem(
            ctx,
            moved!.id,
            moved!.version,
            "unlink-second",
        );
        expect(archived?.archivedAt).toBeDefined();
        expect(
            (await database.select({ id: documents.id }).from(documents).all()).map(
                (row) => row.id,
            ),
        ).toEqual([documentId]);
        expect((await repository.folderCatalog(ctx)).revision).toBe(6);
    });

    it("shares one order-key space between child folders and folder items", async () => {
        const { database, repository } = await createRepository();
        const parent = await repository.createFolder(ctx, { name: "Parent" });
        const first = await repository.createFolder(ctx, { name: "First", parentId: parent.id });
        const documentId = createId();
        await database
            .insert(documents)
            .values({
                createdAtMs: 1,
                createdByInstanceId: "alocalinstance00000000001",
                firstRetainedVersion: 2,
                id: documentId,
                mimeType: "application/x-board",
                stateJson: "{}",
                updatedAtMs: 1,
                version: 1,
            })
            .run();

        const firstItem = await repository.createFolderItem(ctx, parent.id, {
            target: { documentId, kind: "document" },
        });
        const second = await repository.createFolder(ctx, { name: "Second", parentId: parent.id });
        const inserted = await repository.createFolderItem(ctx, parent.id, {
            afterId: first.id,
            target: { documentId, kind: "document" },
        });

        await repository.moveFolder(ctx, second.id, { afterId: inserted.id, parentId: parent.id });

        const catalog = await repository.folderCatalog(ctx);
        const ordered = [
            ...catalog.folders
                .filter((folder) => folder.parentId === parent.id)
                .map((folder) => ({ id: `folder:${folder.id}`, orderKey: folder.orderKey })),
            ...catalog.items
                .filter((item) => item.folderId === parent.id)
                .map((item) => ({ id: `item:${item.id}`, orderKey: item.orderKey })),
        ]
            .sort(
                (left, right) =>
                    (left.orderKey < right.orderKey
                        ? -1
                        : left.orderKey > right.orderKey
                          ? 1
                          : 0) || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
            )
            .map((child) => child.id);

        expect(ordered).toEqual([
            `folder:${first.id}`,
            `item:${inserted.id}`,
            `folder:${second.id}`,
            `item:${firstItem.id}`,
        ]);
        expect(sortsBefore(first.orderKey, firstItem.orderKey)).toBe(true);
        expect(sortsBefore(inserted.orderKey, second.orderKey)).toBe(true);
    });

    it("keeps an item's create receipt under unrelated mutation pressure", async () => {
        const { database, repository } = await createRepository();
        const folder = await repository.createFolder(ctx, { name: "Source" });
        const documentId = createId();
        const itemId = createId();
        const request = {
            id: itemId,
            mutationId: "link-document",
            target: { documentId, kind: "document" } as const,
        };
        await database
            .insert(documents)
            .values({
                createdAtMs: 1,
                createdByInstanceId: "alocalinstance00000000001",
                firstRetainedVersion: 2,
                id: documentId,
                mimeType: "application/x-board",
                stateJson: "{}",
                updatedAtMs: 1,
                version: 1,
            })
            .run();

        const linked = await repository.createFolderItem(ctx, folder.id, request);
        await database.transaction(async (tx) => {
            for (let index = 0; index < 10_000; index += 1) {
                await tx
                    .insert(folderItemMutations)
                    .values({
                        action: "move",
                        createdAtMs: index + 10,
                        itemId: "unrelated-item",
                        mutationId: `unrelated-${String(index)}`,
                        requestFingerprint: `unrelated-${String(index)}`,
                    })
                    .run();
            }
            await recordFolderItemMutationReceipt(withDatabase(createTestRootContext(), tx), {
                action: "move",
                fingerprint: "newest-unrelated",
                itemId: "unrelated-item",
                mutationId: "newest-unrelated",
                now: 10_010,
            });
        });

        expect(await repository.createFolderItem(ctx, folder.id, request)).toEqual(linked);
        expect(
            (
                await database
                    .select({ mutationId: folderItemMutations.mutationId })
                    .from(folderItemMutations)
                    .all()
            ).filter((receipt) => receipt.mutationId.startsWith("unrelated")),
        ).toHaveLength(9_999);
        expect(
            (
                await database
                    .select({ mutationId: folderItemMutations.mutationId })
                    .from(folderItemMutations)
                    .all()
            ).some((receipt) => receipt.mutationId === "link-document"),
        ).toBe(true);
    });

    it("refuses to file a chat into a folder it does not know", async () => {
        const { repository } = await createRepository();

        expect(
            await failureCode(() => repository.setSessionFolder(ctx, "session-1", createId())),
        ).toBe("folder_not_found");
    });

    it("pins shared roots first and keeps their entire tree folder-only", async () => {
        const { database, repository } = await createRepository();
        const ordinary = await repository.createFolder(ctx, { name: "Ordinary" });
        const shared = await repository.createFolder(ctx, { name: "Shared" });
        const child = await repository.createFolder(ctx, { name: "Child", parentId: shared.id });

        const marked = await repository.markFolderShared(ctx, shared.id, "A".repeat(43));

        expect(marked.shared).toBe(true);
        expect(ids(await repository.listFolders(ctx))).toEqual([shared.id, child.id, ordinary.id]);
        expect(
            await failureCode(() =>
                repository.moveFolder(ctx, shared.id, {
                    afterId: null,
                    parentId: ordinary.id,
                }),
            ),
        ).toBe("shared_folder_boundary");

        const documentId = createId();
        await database
            .insert(documents)
            .values({
                createdAtMs: 1,
                createdByInstanceId: "alocalinstance00000000001",
                firstRetainedVersion: 2,
                id: documentId,
                mimeType: "application/x-board",
                stateJson: "{}",
                updatedAtMs: 1,
                version: 1,
            })
            .run();
        expect(
            await failureCode(() =>
                repository.createFolderItem(ctx, child.id, {
                    target: { documentId, kind: "document" },
                }),
            ),
        ).toBe("shared_folder_contents_forbidden");
    });

    it("imports and reconciles a Murmur folder-group state", async () => {
        const { repository } = await createRepository();
        const rootId = createId();
        const firstId = createId();
        const secondId = createId();
        const groupId = "B".repeat(43);

        await repository.applySharedFolderState(ctx, groupId, {
            folders: [
                { id: rootId, name: "Shared", order: 0 },
                { id: firstId, name: "First", order: 0, parentId: rootId },
                { id: secondId, name: "Second", order: 1, parentId: rootId },
            ],
            rootId,
        });

        expect((await repository.getFolder(ctx, rootId))?.shared).toBe(true);
        expect(childrenOf(await repository.listFolders(ctx), rootId)).toEqual([firstId, secondId]);

        await repository.applySharedFolderState(ctx, groupId, {
            folders: [
                { id: rootId, name: "Renamed", order: 0 },
                { id: secondId, name: "Second", order: 0, parentId: rootId },
            ],
            rootId,
        });

        expect((await repository.getFolder(ctx, rootId))?.name).toBe("Renamed");
        const activeChildren = (await repository.listFolders(ctx))
            .filter((folder) => folder.parentId === rootId && folder.archivedAt === undefined)
            .map((folder) => folder.id);
        expect(activeChildren).toEqual([secondId]);
        expect((await repository.getFolder(ctx, firstId))?.archivedAt).toBeDefined();
    });
});

async function createRepository(): Promise<{
    contextChanges: string[][];
    database: Awaited<Awaited<ReturnType<typeof openSessionDatabase>>>["database"];
    events: FolderEvent[];
    foldersDirectory: string;
    repository: FolderRepository;
}> {
    const open = await openSessionDatabase(ctx, ":memory:");
    await migrateSessionDatabase(open.ctx);
    opened.push(open);
    const foldersDirectory = mkdtempSync(join(tmpdir(), "rig-folders-"));
    directories.push(foldersDirectory);
    const events: FolderEvent[] = [];
    const contextChanges: string[][] = [];
    const repository = new FolderRepository({
        database: open.database,
        foldersDirectory,
        onFolderContextChanged: (_operationCtx, folderIds) => {
            contextChanges.push([...folderIds]);
        },
        onEvent: (_operationCtx, event) => {
            events.push(event);
        },
    });
    return { contextChanges, database: open.database, events, foldersDirectory, repository };
}

/** The code the repository refused with, so a test never has to match on a message. */
async function failureCode(body: () => unknown | Promise<unknown>): Promise<FolderErrorCode> {
    try {
        await body();
    } catch (error) {
        if (error instanceof FolderError) return error.code;
        throw error;
    }
    throw new Error("The call was expected to fail.");
}

/** Order keys are compared the way SQLite compares them, byte by byte. */
function sortsBefore(left: string | undefined, right: string | undefined): boolean {
    return left !== undefined && right !== undefined && left < right;
}

function ids(folders: readonly Folder[]): readonly string[] {
    return folders.map((folder) => folder.id);
}

function mode(path: string): number {
    return statSync(path).mode & 0o777;
}

/** The ids of one folder's children, in the order the tree holds them. */
function childrenOf(folders: readonly Folder[], parentId: string): readonly string[] {
    return folders.filter((folder) => folder.parentId === parentId).map((folder) => folder.id);
}
