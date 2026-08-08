import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createId } from "@paralleldrive/cuid2";
import { afterEach, describe, expect, it } from "vitest";

import type { Folder, FolderErrorCode, FolderEvent } from "../../../protocol/index.js";
import { FolderError, FolderRepository } from "../../../folders/FolderRepository.js";
import { migrateSessionDatabase } from "../../database/migrateSessionDatabase.js";
import { openSessionDatabase } from "../../database/openSessionDatabase.js";

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
            path: join(foldersDirectory, folder.id),
            version: 1,
        });
        expect(folder.parentId).toBeUndefined();
        expect(existsSync(folder.path)).toBe(true);
        expect(events.map((event) => event.type)).toEqual(["folder_created"]);
        expect(events[0]?.data.folder.id).toBe(folder.id);
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
        expect(events.map((event) => event.type)).toEqual(["folder_updated"]);
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
        expect(events.map((event) => event.folderId)).toEqual([media.id, videos.id, cuts.id]);
    });

    it("renames a folder and clears its description", () => {
        const { repository, events } = createRepository();
        const media = repository.createFolder({ description: "Video work", name: "Media" });
        events.length = 0;

        const updated = repository.updateFolder(media.id, { description: null, name: "Films" });

        expect(updated).toMatchObject({ name: "Films", version: 2 });
        expect(updated?.description).toBeUndefined();
        expect(events.map((event) => event.type)).toEqual(["folder_updated"]);
        expect(repository.updateFolder(createId(), { name: "Nothing" })).toBeUndefined();
    });

    it("refuses to file a chat into a folder it does not know", () => {
        const { repository } = createRepository();

        expect(failureCode(() => repository.setSessionFolder("session-1", createId()))).toBe(
            "folder_not_found",
        );
    });
});

function createRepository(): {
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
    const repository = new FolderRepository({
        database: open.database,
        foldersDirectory,
        onEvent: (event) => events.push(event),
    });
    return { events, foldersDirectory, repository };
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
