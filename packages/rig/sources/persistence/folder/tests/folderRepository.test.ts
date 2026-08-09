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
import { afterEach, describe, expect, it } from "vitest";

import type { Folder, FolderErrorCode, FolderEvent } from "../../../protocol/index.js";
import { FolderError, FolderRepository } from "../../../folders/FolderRepository.js";
import { migrateSessionDatabase } from "../../database/migrateSessionDatabase.js";
import { openSessionDatabase } from "../../database/openSessionDatabase.js";
import { documents, folderItemMutations } from "../../database/schema.js";
import { recordFolderItemMutationReceipt } from "../../folderItem/folderItemMutationReceipt.js";
import type { TX } from "../../Transaction.js";

const opened: ReturnType<typeof openSessionDatabase>[] = [];
const directories: string[] = [];

afterEach(() => {
    for (const open of opened.splice(0)) open.client.close();
    for (const directory of directories.splice(0)) {
        rmSync(directory, { force: true, recursive: true });
    }
});

describe("FolderRepository", () => {
    it("creates a folder at the root with its own storage directory", () => {
        const { repository, events, foldersDirectory } = createRepository();

        const folder = repository.createFolder({ description: "Video work", name: "Media" });

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

    it("uses private root and child directories", () => {
        const { foldersDirectory, repository } = createRepository();
        chmodSync(foldersDirectory, 0o755);

        const folder = repository.createFolder({ name: "Media" });

        expect(mode(foldersDirectory)).toBe(0o700);
        expect(mode(folder.path)).toBe(0o700);
    });

    it("refuses a symlink where a client-chosen folder directory would be", () => {
        const { foldersDirectory, repository } = createRepository();
        const id = createId();
        const outside = mkdtempSync(join(tmpdir(), "rig-folder-outside-"));
        directories.push(outside);
        symlinkSync(outside, join(foldersDirectory, id));

        expect(failureCode(() => repository.createFolder({ id, name: "Media" }))).toBe(
            "storage_unavailable",
        );
        expect(repository.getFolder(id)).toBeUndefined();
    });

    it("refuses a symlink used as the configured folder storage root", () => {
        const parent = mkdtempSync(join(tmpdir(), "rig-folder-root-parent-"));
        const outside = mkdtempSync(join(tmpdir(), "rig-folder-root-outside-"));
        directories.push(parent, outside);
        const foldersDirectory = join(parent, "folders");
        symlinkSync(outside, foldersDirectory);
        const open = openSessionDatabase(":memory:");
        migrateSessionDatabase(open.database);
        opened.push(open);
        const repository = new FolderRepository({ database: open.database, foldersDirectory });

        expect(failureCode(() => repository.createFolder({ name: "Media" }))).toBe(
            "storage_unavailable",
        );
        expect(statSync(outside).isDirectory()).toBe(true);
    });

    it("refuses a non-directory where a client-chosen folder directory would be", () => {
        const { foldersDirectory, repository } = createRepository();
        const id = createId();
        writeFileSync(join(foldersDirectory, id), "not a folder");

        expect(failureCode(() => repository.createFolder({ id, name: "Media" }))).toBe(
            "storage_unavailable",
        );
        expect(repository.getFolder(id)).toBeUndefined();
    });

    it("revalidates storage before answering an idempotent create", () => {
        const { foldersDirectory, repository } = createRepository();
        const folder = repository.createFolder({ name: "Media" });
        const outside = mkdtempSync(join(tmpdir(), "rig-folder-outside-"));
        directories.push(outside);
        rmSync(folder.path, { recursive: true });
        symlinkSync(outside, join(foldersDirectory, folder.id));

        expect(failureCode(() => repository.createFolder({ id: folder.id, name: "Ignored" }))).toBe(
            "storage_unavailable",
        );
    });

    it("removes only its newly-created empty directory when folder persistence fails", () => {
        const { database, foldersDirectory } = createRepository();
        const id = createId();
        const repository = new FolderRepository({
            database,
            foldersDirectory,
            transaction: <T>(body: (tx: TX) => T): T =>
                database.transaction((tx) => {
                    body(tx);
                    throw new Error("The database could not commit the folder.");
                }),
        });

        expect(() => repository.createFolder({ id, name: "Media" })).toThrow();
        expect(existsSync(join(foldersDirectory, id))).toBe(false);
        expect(repository.getFolder(id)).toBeUndefined();
    });

    it("creates a folder inside a parent and refuses an unknown one", () => {
        const { repository } = createRepository();
        const parent = repository.createFolder({ name: "Media" });

        const child = repository.createFolder({ name: "Videos", parentId: parent.id });

        expect(child.parentId).toBe(parent.id);
        expect(ids(repository.listFolders())).toEqual([parent.id, child.id]);
        expect(
            failureCode(() => repository.createFolder({ name: "Stray", parentId: createId() })),
        ).toBe("parent_not_found");
    });

    it("refuses archived parents and archived ordering siblings", () => {
        const { repository } = createRepository();
        const parent = repository.createFolder({ name: "Parent" });
        const source = repository.createFolder({ name: "Source" });
        const archivedSibling = repository.createFolder({ name: "Archived sibling" });
        repository.archiveFolder(parent.id);
        repository.archiveFolder(archivedSibling.id);

        expect(
            failureCode(() => repository.createFolder({ name: "Child", parentId: parent.id })),
        ).toBe("parent_not_found");
        expect(
            failureCode(() =>
                repository.moveFolder(source.id, { afterId: parent.id, parentId: parent.id }),
            ),
        ).toBe("parent_not_found");
        expect(
            failureCode(() =>
                repository.moveFolder(source.id, {
                    afterId: archivedSibling.id,
                    parentId: null,
                }),
            ),
        ).toBe("sibling_not_found");
    });

    it("answers a repeated client-chosen id with the folder the first attempt made", () => {
        const { repository, events } = createRepository();
        const id = createId();

        const first = repository.createFolder({ id, name: "Media" });
        const second = repository.createFolder({ id, name: "Something else" });

        expect(second).toEqual(first);
        expect(repository.listFolders()).toHaveLength(1);
        expect(events).toHaveLength(1);
    });

    it("rejects an id that is not a cuid2 identity", () => {
        const { repository } = createRepository();

        expect(
            failureCode(() => repository.createFolder({ id: "media folder", name: "Media" })),
        ).toBe("invalid_request");
    });

    it("rejects control characters in names and icons that are not one emoji", () => {
        const { repository } = createRepository();

        expect(failureCode(() => repository.createFolder({ name: "Media\nHidden" }))).toBe(
            "invalid_request",
        );
        expect(failureCode(() => repository.createFolder({ icon: "MP", name: "Media" }))).toBe(
            "invalid_request",
        );
        expect(repository.createFolder({ icon: "👩🏽‍💻", name: "Media" }).icon).toBe("👩🏽‍💻");
    });

    it("orders a drop at the start, between siblings, and at the end", () => {
        const { repository } = createRepository();
        const first = repository.createFolder({ name: "First" });
        const second = repository.createFolder({ name: "Second" });
        const third = repository.createFolder({ name: "Third" });

        const start = repository.moveFolder(third.id, { afterId: null, parentId: null });
        expect(sortsBefore(start?.orderKey, first.orderKey)).toBe(true);
        expect(ids(repository.listFolders())).toEqual([third.id, first.id, second.id]);

        const between = repository.moveFolder(third.id, { afterId: first.id, parentId: null });
        expect(sortsBefore(first.orderKey, between?.orderKey)).toBe(true);
        expect(sortsBefore(between?.orderKey, second.orderKey)).toBe(true);
        expect(ids(repository.listFolders())).toEqual([first.id, third.id, second.id]);

        const end = repository.moveFolder(third.id, { afterId: second.id, parentId: null });
        expect(sortsBefore(second.orderKey, end?.orderKey)).toBe(true);
        expect(ids(repository.listFolders())).toEqual([first.id, second.id, third.id]);
    });

    it("keeps the order key of a drop that changes nothing", () => {
        const { repository, events } = createRepository();
        const first = repository.createFolder({ name: "First" });
        const second = repository.createFolder({ name: "Second" });
        events.length = 0;

        expect(repository.moveFolder(second.id, { afterId: first.id, parentId: null })).toEqual(
            second,
        );
        expect(events).toHaveLength(0);
    });

    it("moves a folder between parents and keeps its storage directory", () => {
        const { repository, events } = createRepository();
        const media = repository.createFolder({ name: "Media" });
        const notes = repository.createFolder({ name: "Notes" });
        const videos = repository.createFolder({ name: "Videos", parentId: media.id });
        events.length = 0;

        const moved = repository.moveFolder(videos.id, { afterId: null, parentId: notes.id });

        expect(moved).toMatchObject({ parentId: notes.id, path: videos.path, version: 2 });
        expect(existsSync(videos.path)).toBe(true);
        expect(ids(repository.listFolders())).toEqual([media.id, notes.id, videos.id]);
        expect(events.map((event) => event.type)).toEqual(["folders_changed"]);
    });

    it("drops a folder from another parent into the exact place it landed", () => {
        const { repository } = createRepository();
        const source = repository.createFolder({ name: "Source" });
        const target = repository.createFolder({ name: "Target" });
        const first = repository.createFolder({ name: "First", parentId: target.id });
        const second = repository.createFolder({ name: "Second", parentId: target.id });
        const third = repository.createFolder({ name: "Third", parentId: target.id });
        const arriving = repository.createFolder({ name: "Arriving", parentId: source.id });

        repository.moveFolder(arriving.id, { afterId: first.id, parentId: target.id });

        expect(childrenOf(repository.listFolders(), target.id)).toEqual([
            first.id,
            arriving.id,
            second.id,
            third.id,
        ]);
    });

    it("drops a folder from another parent at the end of its new row", () => {
        const { repository } = createRepository();
        const source = repository.createFolder({ name: "Source" });
        const target = repository.createFolder({ name: "Target" });
        const first = repository.createFolder({ name: "First", parentId: target.id });
        const second = repository.createFolder({ name: "Second", parentId: target.id });
        const arriving = repository.createFolder({ name: "Arriving", parentId: source.id });

        repository.moveFolder(arriving.id, { afterId: second.id, parentId: target.id });

        expect(childrenOf(repository.listFolders(), target.id)).toEqual([
            first.id,
            second.id,
            arriving.id,
        ]);
    });

    it("refuses a move that would put a folder inside its own subtree", () => {
        const { repository } = createRepository();
        const media = repository.createFolder({ name: "Media" });
        const videos = repository.createFolder({ name: "Videos", parentId: media.id });
        const cuts = repository.createFolder({ name: "Cuts", parentId: videos.id });

        expect(
            failureCode(() =>
                repository.moveFolder(media.id, { afterId: null, parentId: cuts.id }),
            ),
        ).toBe("cycle");
        expect(
            failureCode(() =>
                repository.moveFolder(media.id, { afterId: null, parentId: media.id }),
            ),
        ).toBe("cycle");
        expect(repository.getFolder(media.id)?.parentId).toBeUndefined();
        expect(repository.getFolder(media.id)?.version).toBe(1);
    });

    it("refuses a drop below a folder that is not in the target folder", () => {
        const { repository } = createRepository();
        const media = repository.createFolder({ name: "Media" });
        const notes = repository.createFolder({ name: "Notes" });
        const videos = repository.createFolder({ name: "Videos", parentId: media.id });

        expect(
            failureCode(() =>
                repository.moveFolder(notes.id, { afterId: videos.id, parentId: null }),
            ),
        ).toBe("sibling_not_found");
    });

    it("archives a folder together with everything nested under it", () => {
        const { repository, events } = createRepository();
        const media = repository.createFolder({ name: "Media" });
        const videos = repository.createFolder({ name: "Videos", parentId: media.id });
        const cuts = repository.createFolder({ name: "Cuts", parentId: videos.id });
        const notes = repository.createFolder({ name: "Notes" });
        events.length = 0;

        const archived = repository.archiveFolder(media.id);

        expect(archived?.archivedAt).toBeDefined();
        expect(repository.getFolder(videos.id)?.archivedAt).toBeDefined();
        expect(repository.getFolder(cuts.id)?.archivedAt).toBeDefined();
        expect(repository.getFolder(notes.id)?.archivedAt).toBeUndefined();
        expect(events).toEqual([
            expect.objectContaining({
                data: { revision: 5 },
                type: "folders_changed",
            }),
        ]);
    });

    it("renames a folder and clears its description", () => {
        const { repository, events } = createRepository();
        const media = repository.createFolder({ description: "Video work", name: "Media" });
        events.length = 0;

        const updated = repository.updateFolder(media.id, { description: null, name: "Films" });

        expect(updated).toMatchObject({ name: "Films", version: 2 });
        expect(updated?.description).toBeUndefined();
        expect(events.map((event) => event.type)).toEqual(["folders_changed"]);
        expect(repository.updateFolder(createId(), { name: "Nothing" })).toBeUndefined();
    });

    it("identifies every running folder context invalidated by metadata and ancestry changes", () => {
        const { contextChanges, repository } = createRepository();
        const parent = repository.createFolder({ name: "Media" });
        const child = repository.createFolder({ name: "Cuts", parentId: parent.id });
        contextChanges.length = 0;

        repository.updateFolder(parent.id, { rules: "Keep originals." });
        repository.updateFolder(parent.id, { name: "Films" });
        repository.moveFolder(parent.id, { afterId: null, parentId: null });

        expect(contextChanges).toEqual([[parent.id], [parent.id, child.id]]);
    });

    it("answers an ambiguous mutation retry after newer folder changes without replaying it", () => {
        const { repository } = createRepository();
        const folder = repository.createFolder({ name: "Drafts" });
        const first = repository.updateFolder(
            folder.id,
            { mutationId: "rename-drafts", name: "Cuts" },
            folder.version,
        );
        const second = repository.updateFolder(
            folder.id,
            { mutationId: "rename-cuts", name: "Finals" },
            first?.version,
        );

        expect(
            repository.updateFolder(
                folder.id,
                { mutationId: "rename-drafts", name: "Cuts" },
                folder.version,
            ),
        ).toEqual(second);
        expect(repository.getFolder(folder.id)).toMatchObject({
            name: "Finals",
            version: 3,
        });

        const other = repository.createFolder({ name: "Other" });
        expect(
            failureCode(() =>
                repository.updateFolder(
                    other.id,
                    { mutationId: "rename-drafts", name: "Wrong" },
                    other.version,
                ),
            ),
        ).toBe("invalid_request");
    });

    it("does not advance or publish an update that changes no folder fields", () => {
        const { events, repository } = createRepository();
        const folder = repository.createFolder({ description: "Video work", name: "Media" });
        events.length = 0;

        const unchanged = repository.updateFolder(folder.id, {
            description: "Video work",
            name: " Media ",
        });

        expect(unchanged).toEqual(folder);
        expect(events).toEqual([]);
    });

    it("links duplicate targets in folder-local order and unlinks without touching the target", () => {
        const { database, repository } = createRepository();
        const source = repository.createFolder({ name: "Source" });
        const target = repository.createFolder({ name: "Target" });
        const documentId = createId();
        database
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
        const first = repository.createFolderItem(source.id, {
            id: createId(),
            mutationId: "link-first",
            target: { documentId, kind: "document" },
        });
        const second = repository.createFolderItem(source.id, {
            id: createId(),
            mutationId: "link-second",
            target: { documentId, kind: "document" },
        });

        expect(repository.folderCatalog().items.map((item) => item.id)).toEqual([
            first.id,
            second.id,
        ]);
        const moved = repository.moveFolderItem(
            second.id,
            { afterId: null, folderId: target.id, mutationId: "move-second" },
            second.version,
        );
        expect(moved).toMatchObject({ folderId: target.id, orderKey: "a0", version: 2 });

        const archived = repository.archiveFolderItem(moved!.id, moved!.version, "unlink-second");
        expect(archived?.archivedAt).toBeDefined();
        expect(
            database
                .select({ id: documents.id })
                .from(documents)
                .all()
                .map((row) => row.id),
        ).toEqual([documentId]);
        expect(repository.folderCatalog().revision).toBe(6);
    });

    it("shares one order-key space between child folders and folder items", () => {
        const { database, repository } = createRepository();
        const parent = repository.createFolder({ name: "Parent" });
        const first = repository.createFolder({ name: "First", parentId: parent.id });
        const documentId = createId();
        database
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

        const firstItem = repository.createFolderItem(parent.id, {
            target: { documentId, kind: "document" },
        });
        const second = repository.createFolder({ name: "Second", parentId: parent.id });
        const inserted = repository.createFolderItem(parent.id, {
            afterId: first.id,
            target: { documentId, kind: "document" },
        });

        repository.moveFolder(second.id, { afterId: inserted.id, parentId: parent.id });

        const catalog = repository.folderCatalog();
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

    it("keeps an item's create receipt under unrelated mutation pressure", () => {
        const { database, repository } = createRepository();
        const folder = repository.createFolder({ name: "Source" });
        const documentId = createId();
        const itemId = createId();
        const request = {
            id: itemId,
            mutationId: "link-document",
            target: { documentId, kind: "document" } as const,
        };
        database
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

        const linked = repository.createFolderItem(folder.id, request);
        database.transaction((tx) => {
            for (let index = 0; index < 10_000; index += 1) {
                tx.insert(folderItemMutations)
                    .values({
                        action: "move",
                        createdAtMs: index + 10,
                        itemId: "unrelated-item",
                        mutationId: `unrelated-${String(index)}`,
                        requestFingerprint: `unrelated-${String(index)}`,
                    })
                    .run();
            }
            recordFolderItemMutationReceipt(tx, {
                action: "move",
                fingerprint: "newest-unrelated",
                itemId: "unrelated-item",
                mutationId: "newest-unrelated",
                now: 10_010,
            });
        });

        expect(repository.createFolderItem(folder.id, request)).toEqual(linked);
        expect(
            database
                .select({ mutationId: folderItemMutations.mutationId })
                .from(folderItemMutations)
                .all()
                .filter((receipt) => receipt.mutationId.startsWith("unrelated")),
        ).toHaveLength(9_999);
        expect(
            database
                .select({ mutationId: folderItemMutations.mutationId })
                .from(folderItemMutations)
                .all()
                .some((receipt) => receipt.mutationId === "link-document"),
        ).toBe(true);
    });

    it("refuses to file a chat into a folder it does not know", () => {
        const { repository } = createRepository();

        expect(failureCode(() => repository.setSessionFolder("session-1", createId()))).toBe(
            "folder_not_found",
        );
    });

    it("pins shared roots first and keeps their entire tree folder-only", () => {
        const { database, repository } = createRepository();
        const ordinary = repository.createFolder({ name: "Ordinary" });
        const shared = repository.createFolder({ name: "Shared" });
        const child = repository.createFolder({ name: "Child", parentId: shared.id });

        const marked = repository.markFolderShared(shared.id, "A".repeat(43));

        expect(marked.shared).toBe(true);
        expect(ids(repository.listFolders())).toEqual([shared.id, child.id, ordinary.id]);
        expect(
            failureCode(() =>
                repository.moveFolder(shared.id, {
                    afterId: null,
                    parentId: ordinary.id,
                }),
            ),
        ).toBe("shared_folder_boundary");

        const documentId = createId();
        database
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
            failureCode(() =>
                repository.createFolderItem(child.id, {
                    target: { documentId, kind: "document" },
                }),
            ),
        ).toBe("shared_folder_contents_forbidden");
    });

    it("imports and reconciles a Murmur folder-group state", () => {
        const { repository } = createRepository();
        const rootId = createId();
        const firstId = createId();
        const secondId = createId();
        const groupId = "B".repeat(43);

        repository.applySharedFolderState(groupId, {
            folders: [
                { id: rootId, name: "Shared", order: 0 },
                { id: firstId, name: "First", order: 0, parentId: rootId },
                { id: secondId, name: "Second", order: 1, parentId: rootId },
            ],
            rootId,
        });

        expect(repository.getFolder(rootId)?.shared).toBe(true);
        expect(childrenOf(repository.listFolders(), rootId)).toEqual([firstId, secondId]);

        repository.applySharedFolderState(groupId, {
            folders: [
                { id: rootId, name: "Renamed", order: 0 },
                { id: secondId, name: "Second", order: 0, parentId: rootId },
            ],
            rootId,
        });

        expect(repository.getFolder(rootId)?.name).toBe("Renamed");
        expect(
            repository
                .listFolders()
                .filter((folder) => folder.parentId === rootId && folder.archivedAt === undefined)
                .map((folder) => folder.id),
        ).toEqual([secondId]);
        expect(repository.getFolder(firstId)?.archivedAt).toBeDefined();
    });
});

function createRepository(): {
    contextChanges: string[][];
    database: ReturnType<typeof openSessionDatabase>["database"];
    events: FolderEvent[];
    foldersDirectory: string;
    repository: FolderRepository;
} {
    const open = openSessionDatabase(":memory:");
    migrateSessionDatabase(open.database);
    opened.push(open);
    const foldersDirectory = mkdtempSync(join(tmpdir(), "rig-folders-"));
    directories.push(foldersDirectory);
    const events: FolderEvent[] = [];
    const contextChanges: string[][] = [];
    const repository = new FolderRepository({
        database: open.database,
        foldersDirectory,
        onFolderContextChanged: (folderIds) => contextChanges.push([...folderIds]),
        onEvent: (event) => events.push(event),
    });
    return { contextChanges, database: open.database, events, foldersDirectory, repository };
}

/** The code the repository refused with, so a test never has to match on a message. */
function failureCode(body: () => unknown): FolderErrorCode {
    try {
        body();
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
