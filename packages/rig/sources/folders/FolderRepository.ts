import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { createId } from "@paralleldrive/cuid2";

import {
    createEventIdFactory,
    FOLDER_NAME_MAX_LENGTH,
    type CreateFolderRequest,
    type Folder,
    type FolderErrorCode,
    type FolderEvent,
    type MoveFolderRequest,
    type UpdateFolderRequest,
} from "../protocol/index.js";
import { folderArchive } from "../persistence/folder/folderArchive.js";
import { folderCreate } from "../persistence/folder/folderCreate.js";
import { folderMove } from "../persistence/folder/folderMove.js";
import { folderUpdate } from "../persistence/folder/folderUpdate.js";
import { queryFolder } from "../persistence/folder/queryFolder.js";
import { queryFolders } from "../persistence/folder/queryFolders.js";
import { sessionSetFolder } from "../persistence/folder/sessionSetFolder.js";
import type { SessionDatabase } from "../persistence/database/openSessionDatabase.js";
import { inTx } from "../persistence/inTx.js";
import type { TX } from "../persistence/Transaction.js";
import { clientChosenId } from "../utils/clientChosenId.js";
import { generateKeyBetween } from "../utils/fractionalIndexing.js";
import { getFoldersDirectory } from "./getFoldersDirectory.js";

export class FolderError extends Error {
    readonly code: FolderErrorCode;

    constructor(code: FolderErrorCode, message: string) {
        super(message);
        this.code = code;
        this.name = "FolderError";
    }
}

export interface FolderRepositoryOptions {
    database: SessionDatabase;
    /** Where every folder's flat storage directory lives. Defaults to the user's Happy folders. */
    foldersDirectory?: string;
    homeDirectory?: string;
    now?: () => number;
    onEvent?: (event: FolderEvent) => void;
    transaction?: <T>(body: (tx: TX) => T) => T;
}

/**
 * The folder tree.
 *
 * Folders are nested only virtually. The tree lives in the database, while storage is flat: every
 * folder owns one directory named after its own id, created the moment the folder is, and a move
 * rearranges the tree without touching the disk.
 */
export class FolderRepository {
    readonly #createEventId = createEventIdFactory();
    readonly #database: SessionDatabase;
    readonly #foldersDirectory: string;
    readonly #now: () => number;
    readonly #onEvent: ((event: FolderEvent) => void) | undefined;
    readonly #transactionRunner: (<T>(body: (tx: TX) => T) => T) | undefined;

    constructor(options: FolderRepositoryOptions) {
        this.#database = options.database;
        this.#foldersDirectory =
            options.foldersDirectory ??
            getFoldersDirectory(process.env, options.homeDirectory ?? homedir());
        this.#now = options.now ?? Date.now;
        this.#onEvent = options.onEvent;
        this.#transactionRunner = options.transaction;
    }

    /** The whole tree, every parent ahead of what is nested under it. */
    listFolders(): readonly Folder[] {
        return queryFolders(this.#database);
    }

    getFolder(folderId: string): Folder | undefined {
        return queryFolder(this.#database, folderId);
    }

    /**
     * Creates one folder and the storage directory it owns.
     *
     * The client names what it creates, so repeating a request that already landed answers with the
     * folder the first attempt made instead of creating a second one.
     */
    createFolder(request: CreateFolderRequest): Folder {
        const id = this.#folderId(request.id);
        const existing = this.getFolder(id);
        if (existing !== undefined) return existing;
        const name = this.#folderName(request.name);
        if (request.parentId !== undefined && this.getFolder(request.parentId) === undefined) {
            throw new FolderError("parent_not_found", "That parent folder was not found.");
        }
        const path = this.#createStorageDirectory(id);
        const now = this.#now();
        return this.#mutate((tx) => {
            folderCreate(tx, {
                ...(request.description === undefined ? {} : { description: request.description }),
                ...(request.icon === undefined ? {} : { icon: request.icon }),
                id,
                name,
                now,
                ...(request.parentId === undefined ? {} : { parentId: request.parentId }),
                path,
                ...(request.rules === undefined ? {} : { rules: request.rules }),
            });
            const created = queryFolder(tx, id);
            if (created === undefined) {
                throw new FolderError("folder_not_found", "The new folder could not be read back.");
            }
            this.#publish("folder_created", created);
            return created;
        });
    }

    updateFolder(
        folderId: string,
        request: UpdateFolderRequest,
        expectedVersion?: number,
    ): Folder | undefined {
        const current = this.getFolder(folderId);
        if (current === undefined) return undefined;
        if (expectedVersion !== undefined && expectedVersion !== current.version) {
            throw new Error("The folder changed before it could be updated.");
        }
        const name = request.name === undefined ? undefined : this.#folderName(request.name);
        return this.#mutate((tx) => {
            const changed = folderUpdate(
                tx,
                folderId,
                {
                    ...(request.description === undefined
                        ? {}
                        : { description: request.description }),
                    ...(request.icon === undefined ? {} : { icon: request.icon }),
                    ...(name === undefined ? {} : { name }),
                    ...(request.rules === undefined ? {} : { rules: request.rules }),
                },
                this.#now(),
                expectedVersion,
            );
            if (changed === 0) {
                if (expectedVersion !== undefined) {
                    throw new Error("The folder changed before it could be updated.");
                }
                return queryFolder(tx, folderId);
            }
            return this.#published(tx, folderId);
        });
    }

    /**
     * Rearranges the tree from one drag-and-drop.
     *
     * Only the folder's parent and order key change; its storage directory stays where it is, and a
     * folder can never be dropped inside its own subtree.
     */
    moveFolder(
        folderId: string,
        request: MoveFolderRequest,
        expectedVersion?: number,
    ): Folder | undefined {
        const folders = this.listFolders();
        const current = folders.find((folder) => folder.id === folderId);
        if (current === undefined) return undefined;
        if (expectedVersion !== undefined && expectedVersion !== current.version) {
            throw new Error("The folder changed before it could be moved.");
        }
        const parentId = request.parentId ?? undefined;
        if (parentId !== undefined) {
            const parent = folders.find((folder) => folder.id === parentId);
            if (parent === undefined) {
                throw new FolderError("parent_not_found", "That parent folder was not found.");
            }
            if (parentId === folderId || isDescendant(folders, parentId, folderId)) {
                throw new FolderError(
                    "cycle",
                    "A folder cannot be moved inside itself or one of the folders it holds.",
                );
            }
        }
        if (request.afterId === folderId) {
            throw new FolderError("invalid_request", "A folder cannot be placed after itself.");
        }
        const orderKey = orderKeyForDrop(folders, current, parentId, request.afterId);
        if (orderKey === current.orderKey && parentId === current.parentId) return current;
        return this.#mutate((tx) => {
            const changed = folderMove(
                tx,
                folderId,
                request.parentId,
                orderKey,
                this.#now(),
                expectedVersion,
            );
            if (changed === 0) {
                if (expectedVersion !== undefined) {
                    throw new Error("The folder changed before it could be moved.");
                }
                return queryFolder(tx, folderId);
            }
            return this.#published(tx, folderId);
        });
    }

    /** Puts a folder away together with everything nested under it. */
    archiveFolder(folderId: string): Folder | undefined {
        const folders = this.listFolders();
        const folder = folders.find((candidate) => candidate.id === folderId);
        if (folder === undefined) return undefined;
        const subtree = collectSubtree(folders, folderId).filter(
            (candidate) => candidate.archivedAt === undefined,
        );
        if (subtree.length === 0) return folder;
        return this.#mutate((tx) => {
            folderArchive(tx, folderId, this.#now());
            for (const archived of subtree) this.#published(tx, archived.id);
            return queryFolder(tx, folderId);
        });
    }

    /** Files one chat into a folder, or takes it back out into Unsorted with `null`. */
    setSessionFolder(sessionId: string, folderId: string | null): void {
        if (folderId !== null) {
            const folder = this.getFolder(folderId);
            if (folder === undefined || folder.archivedAt !== undefined) {
                throw new FolderError("folder_not_found", "That folder was not found.");
            }
        }
        this.#mutate((tx) => sessionSetFolder(tx, sessionId, folderId, this.#now()));
    }

    #createStorageDirectory(folderId: string): string {
        const path = join(this.#foldersDirectory, folderId);
        try {
            mkdirSync(path, { recursive: true });
        } catch {
            throw new FolderError(
                "storage_unavailable",
                "The folder's storage directory could not be created.",
            );
        }
        return path;
    }

    #folderId(requested: string | undefined): string {
        if (requested === undefined) return createId();
        try {
            return clientChosenId(requested, "folder");
        } catch {
            throw new FolderError("invalid_request", "The folder ID must be a cuid2 identity.");
        }
    }

    #folderName(requested: string): string {
        const name = requested.trim();
        if (name.length === 0) {
            throw new FolderError("invalid_request", "A folder needs a name.");
        }
        if (name.length > FOLDER_NAME_MAX_LENGTH) {
            throw new FolderError("invalid_request", "That folder name is too long.");
        }
        return name;
    }

    #mutate<T>(body: (tx: TX) => T): T {
        if (this.#transactionRunner !== undefined) return this.#transactionRunner(body);
        return inTx(this.#database, body);
    }

    #published(tx: TX, folderId: string): Folder | undefined {
        const folder = queryFolder(tx, folderId);
        if (folder !== undefined) this.#publish("folder_updated", folder);
        return folder;
    }

    #publish(type: FolderEvent["type"], folder: Folder): void {
        this.#onEvent?.({
            createdAt: this.#now(),
            data: { folder },
            folderId: folder.id,
            id: this.#createEventId(),
            type,
        });
    }
}

/**
 * One folder and everything nested under it, the parent always ahead of its children.
 *
 * The tree arrives in tree order, so a folder belongs to the subtree exactly when its parent
 * already did.
 */
function collectSubtree(folders: readonly Folder[], rootId: string): readonly Folder[] {
    const included = new Set<string>();
    const subtree: Folder[] = [];
    for (const folder of folders) {
        const inside =
            folder.id === rootId ||
            (folder.parentId !== undefined && included.has(folder.parentId));
        if (!inside) continue;
        included.add(folder.id);
        subtree.push(folder);
    }
    return subtree;
}

/** Whether `folderId` sits anywhere under `ancestorId` in the tree. */
function isDescendant(folders: readonly Folder[], folderId: string, ancestorId: string): boolean {
    const parents = new Map(folders.map((folder) => [folder.id, folder.parentId]));
    const seen = new Set<string>();
    let current = parents.get(folderId);
    while (current !== undefined && !seen.has(current)) {
        if (current === ancestorId) return true;
        seen.add(current);
        current = parents.get(current);
    }
    return false;
}

/**
 * The order key one drop lands on.
 *
 * `afterId` is the sibling the folder was dropped below, and `null` means it landed first. A drop
 * that changes nothing keeps the key the folder already has.
 */
function orderKeyForDrop(
    folders: readonly Folder[],
    folder: Folder,
    parentId: string | undefined,
    afterId: string | null,
): string {
    const siblings = folders.filter((candidate) => candidate.parentId === parentId);
    if (parentId === folder.parentId) {
        const index = siblings.findIndex((candidate) => candidate.id === folder.id);
        const predecessor = index > 0 ? (siblings[index - 1]?.id ?? null) : null;
        if (predecessor === afterId) return folder.orderKey;
    }
    const remaining = siblings.filter((candidate) => candidate.id !== folder.id);
    if (afterId === null) return generateKeyBetween(null, remaining[0]?.orderKey ?? null);
    const index = remaining.findIndex((candidate) => candidate.id === afterId);
    if (index === -1) {
        throw new FolderError(
            "sibling_not_found",
            "The folder it was dropped below is not in that folder.",
        );
    }
    return generateKeyBetween(
        remaining[index]?.orderKey ?? null,
        remaining[index + 1]?.orderKey ?? null,
    );
}
