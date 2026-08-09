import { chmodSync, lstatSync, mkdirSync, realpathSync, rmdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { createId } from "@paralleldrive/cuid2";
import { sql } from "drizzle-orm";

import {
    type CreateFolderItemRequest,
    createEventIdFactory,
    FOLDER_NAME_MAX_LENGTH,
    type CreateFolderRequest,
    type Folder,
    type FolderItem,
    type FolderErrorCode,
    type FolderEvent,
    type ListFoldersResponse,
    type MoveFolderItemRequest,
    type MoveFolderRequest,
    MAX_SHARED_FOLDER_NODES,
    type SharedFolderNode,
    type SharedFolderState,
    type UpdateFolderRequest,
} from "../protocol/index.js";
import { folderArchive } from "../persistence/folder/folderArchive.js";
import { folderCreate, type FolderCreateResult } from "../persistence/folder/folderCreate.js";
import { folderMove } from "../persistence/folder/folderMove.js";
import { folderMarkShared } from "../persistence/folder/folderMarkShared.js";
import { folderRestoreShared } from "../persistence/folder/folderRestoreShared.js";
import { folderUpdate } from "../persistence/folder/folderUpdate.js";
import { advanceFolderCatalogRevision } from "../persistence/folder/advanceFolderCatalogRevision.js";
import { queryFolderCatalogRevision } from "../persistence/folder/queryFolderCatalogRevision.js";
import { queryFolder } from "../persistence/folder/queryFolder.js";
import { queryFolders } from "../persistence/folder/queryFolders.js";
import {
    queryFolderShareRootProblem,
    queryFolderSharedGroup,
    queryFolderSubtreeHasContents,
    querySharedFolderRoot,
} from "../persistence/folder/queryFolderSharedGroup.js";
import { folderItemArchive } from "../persistence/folderItem/folderItemArchive.js";
import { folderItemCreate } from "../persistence/folderItem/folderItemCreate.js";
import { folderItemMove } from "../persistence/folderItem/folderItemMove.js";
import { queryFolderItem, queryFolderItems } from "../persistence/folderItem/queryFolderItems.js";
import {
    folderItemsWithActiveTargets,
    queryFolderItemTargetExists,
} from "../persistence/folderItem/queryFolderItemTargetExists.js";
import {
    queryFolderItemMutationReceipt,
    recordFolderItemMutationReceipt,
} from "../persistence/folderItem/folderItemMutationReceipt.js";
import {
    SESSION_SCOPE_MUTATION_ACTION,
    sessionMoveScope,
    type SessionScopeMove,
} from "../persistence/session/sessionMoveScope.js";
import { querySessionMutationReceipt } from "../persistence/session/querySessionMutationReceipt.js";
import { sessionRecordMutationReceipt } from "../persistence/session/sessionRecordMutationReceipt.js";
import type { SessionDatabase } from "../persistence/database/openSessionDatabase.js";
import { inTx } from "../persistence/inTx.js";
import type { TX } from "../persistence/Transaction.js";
import { clientChosenId } from "../utils/clientChosenId.js";
import { generateKeyBetween } from "../utils/fractionalIndexing.js";
import { orderKeyAfter } from "../utils/orderKeyAfter.js";
import { getFoldersDirectory } from "./getFoldersDirectory.js";
import { getUnsortedDirectory } from "./getUnsortedDirectory.js";
import {
    queryFolderChildren,
    type FolderChildOrder,
} from "../persistence/folder/queryFolderChildren.js";

type FolderMutationAction = "archive" | "create" | "move" | "update";
const MAX_FOLDER_MUTATION_RECEIPTS = 10_000;

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
    onFolderContextChanged?: (folderIds: readonly string[]) => void;
    onSessionsArchived?: (sessionIds: readonly string[]) => void;
    unsortedDirectory?: string;
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
    readonly #onFolderContextChanged: ((folderIds: readonly string[]) => void) | undefined;
    readonly #onSessionsArchived: ((sessionIds: readonly string[]) => void) | undefined;
    readonly #transactionRunner: (<T>(body: (tx: TX) => T) => T) | undefined;
    readonly #unsortedDirectory: string;

    constructor(options: FolderRepositoryOptions) {
        this.#database = options.database;
        this.#foldersDirectory =
            options.foldersDirectory ??
            getFoldersDirectory(process.env, options.homeDirectory ?? homedir());
        this.#now = options.now ?? Date.now;
        this.#unsortedDirectory =
            options.unsortedDirectory ?? getUnsortedDirectory(options.homeDirectory ?? homedir());
        this.#onEvent = options.onEvent;
        this.#onFolderContextChanged = options.onFolderContextChanged;
        this.#onSessionsArchived = options.onSessionsArchived;
        this.#transactionRunner = options.transaction;
    }

    /** The whole tree, every parent ahead of what is nested under it. */
    listFolders(): readonly Folder[] {
        return queryFolders(this.#database);
    }

    folderCatalog(): ListFoldersResponse {
        return this.#mutate((tx) => {
            const items = queryFolderItems(tx);
            return {
                folders: [...queryFolders(tx)],
                items: [...folderItemsWithActiveTargets(tx, items)],
                revision: queryFolderCatalogRevision(tx),
            };
        });
    }

    folderCatalogRevision(): number {
        return queryFolderCatalogRevision(this.#database);
    }

    getFolder(folderId: string): Folder | undefined {
        return queryFolder(this.#database, folderId);
    }

    getFolderItem(itemId: string): FolderItem | undefined {
        return queryFolderItem(this.#database, itemId);
    }

    createFolderItem(folderId: string, request: CreateFolderItemRequest): FolderItem {
        if (this.sharedFolderGroup(folderId) !== undefined) {
            throw new FolderError(
                "shared_folder_contents_forbidden",
                "A shared folder can contain only folders.",
            );
        }
        const fingerprint = JSON.stringify({
            afterId: request.afterId ?? (request.afterId === null ? null : "omitted"),
            folderId,
            id: request.id ?? null,
            target: request.target,
        });
        const applied = this.#itemReceipt(request.mutationId, "create", fingerprint);
        if (applied !== undefined) {
            const item = this.getFolderItem(applied);
            if (item !== undefined) return item;
        }
        const id =
            request.id === undefined
                ? createId()
                : (() => {
                      try {
                          return clientChosenId(request.id, "folder item");
                      } catch {
                          throw new FolderError(
                              "invalid_request",
                              "The folder item ID must be a cuid2 identity.",
                          );
                      }
                  })();
        if (this.getFolderItem(id) !== undefined) {
            throw new FolderError("invalid_request", "That folder item ID is already in use.");
        }
        if (this.getFolder(id) !== undefined) {
            throw new FolderError("invalid_request", "That folder item ID is already in use.");
        }
        if (!queryFolderItemTargetExists(this.#database, request.target)) {
            throw new FolderError("target_not_found", "That folder item target was not found.");
        }
        const siblings = queryFolderChildren(this.#database, folderId);
        const appendedKey = generateKeyBetween(siblings.at(-1)?.orderKey ?? null, null);
        let orderKey = appendedKey;
        if (request.afterId !== undefined) {
            if (request.afterId === id) {
                throw new FolderError(
                    "invalid_request",
                    "A folder item cannot be placed after itself.",
                );
            }
            try {
                orderKey = orderKeyAfter(
                    [...siblings, { id, orderKey: appendedKey }],
                    id,
                    request.afterId,
                );
            } catch {
                throw new FolderError(
                    "sibling_not_found",
                    "That preceding folder or item was not found in the folder.",
                );
            }
        }
        return this.#mutate((tx) => {
            const outcome = folderItemCreate(tx, {
                folderId,
                id,
                now: this.#now(),
                orderKey,
                target: request.target,
            });
            if (outcome.outcome === "folder_not_found") {
                throw new FolderError("folder_not_found", "That folder was not found.");
            }
            if (outcome.outcome === "id_conflict") {
                throw new FolderError("invalid_request", "That folder item ID is already in use.");
            }
            this.#recordItemReceipt(tx, request.mutationId, "create", fingerprint, id);
            this.#advanceItemAndPublish(tx, request.mutationId);
            return queryFolderItem(tx, id)!;
        });
    }

    moveFolderItem(
        itemId: string,
        request: MoveFolderItemRequest,
        expectedVersion?: number,
    ): FolderItem | undefined {
        const fingerprint = JSON.stringify({ expectedVersion, itemId, request });
        const applied = this.#itemReceipt(request.mutationId, "move", fingerprint);
        if (applied !== undefined) return this.getFolderItem(applied);
        const current = this.getFolderItem(itemId);
        if (current === undefined || current.archivedAt !== undefined) return undefined;
        if (expectedVersion !== undefined && current.version !== expectedVersion) {
            throw new FolderError("version_conflict", "The folder item changed before it moved.");
        }
        if (this.sharedFolderGroup(request.folderId) !== undefined) {
            throw new FolderError(
                "shared_folder_contents_forbidden",
                "A shared folder can contain only folders.",
            );
        }
        if (request.afterId === itemId) {
            throw new FolderError(
                "invalid_request",
                "A folder item cannot be placed after itself.",
            );
        }
        const siblings = queryFolderChildren(this.#database, request.folderId).filter(
            (child) => child.id !== itemId,
        );
        const placeholder =
            request.folderId === current.folderId
                ? current
                : {
                      id: itemId,
                      orderKey: generateKeyBetween(siblings.at(-1)?.orderKey ?? null, null),
                  };
        let orderKey: string;
        try {
            orderKey = orderKeyAfter([...siblings, placeholder], itemId, request.afterId);
        } catch {
            throw new FolderError(
                "sibling_not_found",
                "That preceding folder or item was not found in the folder.",
            );
        }
        if (request.folderId === current.folderId && orderKey === current.orderKey) {
            this.#mutate((tx) =>
                this.#recordItemReceipt(tx, request.mutationId, "move", fingerprint, itemId),
            );
            return current;
        }
        return this.#mutate((tx) => {
            const outcome = folderItemMove(
                tx,
                itemId,
                request.folderId,
                orderKey,
                this.#now(),
                expectedVersion,
            );
            if (outcome.outcome === "folder_not_found") {
                throw new FolderError("folder_not_found", "That folder was not found.");
            }
            if (outcome.outcome === "version_conflict") {
                throw new FolderError(
                    "version_conflict",
                    "The folder item changed before it moved.",
                );
            }
            if (outcome.outcome === "item_not_found") return undefined;
            this.#recordItemReceipt(tx, request.mutationId, "move", fingerprint, itemId);
            this.#advanceItemAndPublish(tx, request.mutationId);
            return queryFolderItem(tx, itemId);
        });
    }

    archiveFolderItem(
        itemId: string,
        expectedVersion?: number,
        mutationId?: string,
    ): FolderItem | undefined {
        const fingerprint = JSON.stringify({ expectedVersion, itemId });
        const applied = this.#itemReceipt(mutationId, "archive", fingerprint);
        if (applied !== undefined) return this.getFolderItem(applied);
        const current = this.getFolderItem(itemId);
        if (current === undefined) return undefined;
        if (expectedVersion !== undefined && current.version !== expectedVersion) {
            throw new FolderError(
                "version_conflict",
                "The folder item changed before it was archived.",
            );
        }
        if (current.archivedAt !== undefined) {
            this.#mutate((tx) =>
                this.#recordItemReceipt(tx, mutationId, "archive", fingerprint, itemId),
            );
            return current;
        }
        return this.#mutate((tx) => {
            const changed = folderItemArchive(tx, itemId, this.#now(), expectedVersion);
            if (changed === 0) {
                throw new FolderError(
                    "version_conflict",
                    "The folder item changed before it was archived.",
                );
            }
            this.#recordItemReceipt(tx, mutationId, "archive", fingerprint, itemId);
            this.#advanceItemAndPublish(tx, mutationId);
            return queryFolderItem(tx, itemId);
        });
    }

    /** Resolves one active folder through its enforced flat-storage boundary. */
    activeFolderStoragePath(folderId: string): string {
        const folder = this.getFolder(folderId);
        if (folder === undefined || folder.archivedAt !== undefined) {
            throw new FolderError("folder_not_found", "That folder was not found.");
        }
        if (this.sharedFolderGroup(folderId) !== undefined) {
            throw new FolderError(
                "shared_folder_contents_forbidden",
                "A shared folder can contain only folders.",
            );
        }
        return this.#revalidateStorageDirectory(folder);
    }

    /** Revalidates persisted storage even when its virtual folder is already archived. */
    folderStoragePath(folderId: string): string {
        const folder = this.getFolder(folderId);
        if (folder === undefined) {
            throw new FolderError("folder_not_found", "That folder was not found.");
        }
        return this.#revalidateStorageDirectory(folder);
    }

    /**
     * Creates one folder and the storage directory it owns.
     *
     * The client names what it creates, so repeating a request that already landed answers with the
     * folder the first attempt made instead of creating a second one.
     */
    createFolder(request: CreateFolderRequest): Folder {
        const id = this.#folderId(request.id);
        if (this.#wasMutationApplied(this.#database, request.mutationId, "create", id)) {
            const applied = this.getFolder(id);
            if (applied !== undefined) return applied;
        }
        const existing = this.getFolder(id);
        if (existing !== undefined) {
            this.#validateStorageDirectory(id, existing.path);
            this.#rememberNoopMutation(request.mutationId, "create", id);
            return existing;
        }
        if (this.getFolderItem(id) !== undefined) {
            throw new FolderError("invalid_request", "That folder ID is already in use.");
        }
        const name = this.#folderName(request.name);
        if (request.parentId !== undefined) {
            const parent = this.getFolder(request.parentId);
            if (parent === undefined || parent.archivedAt !== undefined) {
                throw new FolderError("parent_not_found", "That parent folder was not found.");
            }
            const sharedGroupId = this.sharedFolderGroup(request.parentId);
            const sharedRootId =
                sharedGroupId === undefined ? undefined : this.sharedFolderRoot(sharedGroupId);
            if (
                sharedRootId !== undefined &&
                this.sharedFolderState(sharedRootId).folders.length >= MAX_SHARED_FOLDER_NODES
            ) {
                throw new FolderError(
                    "invalid_request",
                    "A shared folder cannot contain more folders.",
                );
            }
        }
        const storage = this.#createStorageDirectory(id);
        const now = this.#now();
        const icon = request.icon === undefined ? undefined : this.#folderIcon(request.icon);
        let created: Folder;
        try {
            created = this.#mutate((tx) => {
                const outcome = folderCreate(tx, {
                    ...(request.description === undefined
                        ? {}
                        : { description: request.description }),
                    ...(icon === undefined ? {} : { icon }),
                    id,
                    name,
                    now,
                    ...(request.parentId === undefined ? {} : { parentId: request.parentId }),
                    path: storage.path,
                    ...(request.rules === undefined ? {} : { rules: request.rules }),
                });
                this.#throwForCreateOutcome(outcome);
                const created = queryFolder(tx, id);
                if (created === undefined) {
                    throw new FolderError(
                        "folder_not_found",
                        "The new folder could not be read back.",
                    );
                }
                this.#advanceAndPublish(tx, request.mutationId, "create", id);
                return created;
            });
        } catch (error) {
            if (storage.created) this.#removeEmptyStorageDirectory(id, storage.path);
            throw error;
        }
        return created;
    }

    updateFolder(
        folderId: string,
        request: UpdateFolderRequest,
        expectedVersion?: number,
    ): Folder | undefined {
        if (this.#wasMutationApplied(this.#database, request.mutationId, "update", folderId)) {
            return this.getFolder(folderId);
        }
        const current = this.getFolder(folderId);
        if (current === undefined) return undefined;
        if (expectedVersion !== undefined && expectedVersion !== current.version) {
            throw new FolderError(
                "version_conflict",
                "The folder changed before it could be updated.",
            );
        }
        const name = request.name === undefined ? undefined : this.#folderName(request.name);
        const icon =
            request.icon === undefined || request.icon === null
                ? request.icon
                : this.#folderIcon(request.icon);
        const unchanged =
            (request.description === undefined ||
                (request.description ?? undefined) === current.description) &&
            (icon === undefined || (icon ?? undefined) === current.icon) &&
            (name === undefined || name === current.name) &&
            (request.rules === undefined || (request.rules ?? undefined) === current.rules);
        if (unchanged) {
            this.#rememberNoopMutation(request.mutationId, "update", folderId);
            return current;
        }
        const updated = this.#mutate((tx) => {
            const changed = folderUpdate(
                tx,
                folderId,
                {
                    ...(request.description === undefined
                        ? {}
                        : { description: request.description }),
                    ...(icon === undefined ? {} : { icon }),
                    ...(name === undefined ? {} : { name }),
                    ...(request.rules === undefined ? {} : { rules: request.rules }),
                },
                this.#now(),
                expectedVersion,
            );
            if (changed === 0) {
                if (expectedVersion !== undefined) {
                    throw new FolderError(
                        "version_conflict",
                        "The folder changed before it could be updated.",
                    );
                }
                return queryFolder(tx, folderId);
            }
            const folder = queryFolder(tx, folderId);
            this.#advanceAndPublish(tx, request.mutationId, "update", folderId);
            return folder;
        });
        if (updated !== undefined) {
            const changesOwnContext =
                request.description !== undefined ||
                request.name !== undefined ||
                request.rules !== undefined;
            if (changesOwnContext) {
                const affected =
                    request.name === undefined
                        ? [folderId]
                        : collectSubtree(this.listFolders(), folderId).map((folder) => folder.id);
                this.#onFolderContextChanged?.(affected);
            }
        }
        return updated;
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
        if (this.#wasMutationApplied(this.#database, request.mutationId, "move", folderId)) {
            return this.getFolder(folderId);
        }
        const folders = this.listFolders();
        const current = folders.find((folder) => folder.id === folderId);
        if (current === undefined) return undefined;
        if (expectedVersion !== undefined && expectedVersion !== current.version) {
            throw new FolderError(
                "version_conflict",
                "The folder changed before it could be moved.",
            );
        }
        const parentId = request.parentId ?? undefined;
        if (current.shared && parentId !== undefined) {
            throw new FolderError(
                "shared_folder_boundary",
                "A shared folder must stay at the root.",
            );
        }
        if (parentId !== undefined) {
            const parent = folders.find((folder) => folder.id === parentId);
            if (parent === undefined || parent.archivedAt !== undefined) {
                throw new FolderError("parent_not_found", "That parent folder was not found.");
            }
            if (
                this.sharedFolderGroup(parentId) !== undefined &&
                queryFolderSubtreeHasContents(this.#database, folderId)
            ) {
                throw new FolderError(
                    "shared_folder_contents_forbidden",
                    "A shared folder can contain only folders.",
                );
            }
            const targetGroupId = this.sharedFolderGroup(parentId);
            const currentGroupId = this.sharedFolderGroup(folderId);
            const targetRootId =
                targetGroupId === undefined ? undefined : this.sharedFolderRoot(targetGroupId);
            if (targetRootId !== undefined && targetGroupId !== currentGroupId) {
                const arrivingCount = collectSubtree(folders, folderId).filter(
                    (folder) => folder.archivedAt === undefined,
                ).length;
                if (
                    this.sharedFolderState(targetRootId).folders.length + arrivingCount >
                    MAX_SHARED_FOLDER_NODES
                ) {
                    throw new FolderError(
                        "invalid_request",
                        "A shared folder cannot contain more folders.",
                    );
                }
            }
        }
        if (request.afterId === folderId) {
            throw new FolderError("invalid_request", "A folder cannot be placed after itself.");
        }
        const orderKey = orderKeyForDrop(
            queryFolderChildren(this.#database, parentId ?? null),
            current,
            parentId,
            request.afterId,
        );
        if (parentId === current.parentId && orderKey === current.orderKey) {
            this.#rememberNoopMutation(request.mutationId, "move", folderId);
            return current;
        }
        const moved = this.#mutate((tx) => {
            const outcome = folderMove(
                tx,
                folderId,
                request.parentId,
                orderKey,
                this.#now(),
                expectedVersion,
            );
            switch (outcome.outcome) {
                case "moved":
                    const folder = queryFolder(tx, folderId);
                    this.#advanceAndPublish(tx, request.mutationId, "move", folderId);
                    return folder;
                case "folder_not_found":
                    return undefined;
                case "parent_not_found":
                case "parent_archived":
                    throw new FolderError("parent_not_found", "That parent folder was not found.");
                case "cycle":
                    throw new FolderError(
                        "cycle",
                        "A folder cannot be moved inside itself or one of the folders it holds.",
                    );
                case "version_conflict":
                    if (expectedVersion !== undefined) {
                        throw new FolderError(
                            "version_conflict",
                            "The folder changed before it could be moved.",
                        );
                    }
                    return queryFolder(tx, folderId);
            }
        });
        if (moved !== undefined && parentId !== current.parentId) {
            this.#onFolderContextChanged?.(
                collectSubtree(this.listFolders(), folderId).map((folder) => folder.id),
            );
        }
        return moved;
    }

    /** Puts a folder away together with everything nested under it. */
    archiveFolder(
        folderId: string,
        expectedVersion?: number,
        mutationId?: string,
    ): Folder | undefined {
        if (this.#wasMutationApplied(this.#database, mutationId, "archive", folderId)) {
            return this.getFolder(folderId);
        }
        const folders = this.listFolders();
        const folder = folders.find((candidate) => candidate.id === folderId);
        if (folder === undefined) return undefined;
        if (folder.shared) {
            throw new FolderError(
                "shared_folder_boundary",
                "A shared folder cannot be archived while its Murmur group is active.",
            );
        }
        if (expectedVersion !== undefined && expectedVersion !== folder.version) {
            throw new FolderError(
                "version_conflict",
                "The folder changed before it could be archived.",
            );
        }
        const subtree = collectSubtree(folders, folderId).filter(
            (candidate) => candidate.archivedAt === undefined,
        );
        if (subtree.length === 0) {
            this.#rememberNoopMutation(mutationId, "archive", folderId);
            return folder;
        }
        let archivedSessionIds: readonly string[] = [];
        const result = this.#mutate((tx) => {
            archivedSessionIds = folderArchive(tx, folderId, this.#now()).sessionIds;
            this.#advanceAndPublish(tx, mutationId, "archive", folderId);
            return queryFolder(tx, folderId);
        });
        this.#onSessionsArchived?.(archivedSessionIds);
        return result;
    }

    /** Files one chat into a folder, or takes it back out into Unsorted with `null`. */
    setSessionFolder(
        sessionId: string,
        folderId: string | null,
        afterId?: string | null,
        mutationId?: string,
    ): SessionScopeMove {
        const now = this.#now();
        if (folderId === null) {
            const storage = this.#privateUnsortedDirectory(sessionId);
            try {
                return this.#mutate((tx) =>
                    sessionMoveScope(tx, {
                        cwd: storage.path,
                        ...(afterId === undefined ? {} : { afterId }),
                        ...(mutationId === undefined ? {} : { mutationId }),
                        now,
                        scope: { kind: "unsorted" },
                        sessionId,
                    }),
                );
            } catch (error) {
                if (storage.created) {
                    this.removeNewUnsortedSessionDirectory(sessionId, storage.path);
                }
                throw error;
            }
        }
        if (this.sharedFolderGroup(folderId) !== undefined) {
            throw new FolderError(
                "shared_folder_contents_forbidden",
                "A shared folder can contain only folders.",
            );
        }
        const path = this.activeFolderStoragePath(folderId);
        return this.#mutate((tx) =>
            sessionMoveScope(tx, {
                cwd: path,
                ...(afterId === undefined ? {} : { afterId }),
                ...(mutationId === undefined ? {} : { mutationId }),
                now,
                scope: { folderId, kind: "folder" },
                sessionId,
            }),
        );
    }

    /** The canonical, path-free current state of one root and every active folder below it. */
    sharedFolderState(rootFolderId: string): SharedFolderState {
        const folders = collectSubtree(this.listFolders(), rootFolderId).filter(
            (folder) => folder.archivedAt === undefined,
        );
        if (folders.length === 0 || folders[0]?.id !== rootFolderId) {
            throw new FolderError("folder_not_found", "That folder was not found.");
        }
        const positions = new Map<string, number>();
        return {
            folders: folders.map((folder) => {
                const parent = folder.parentId ?? "";
                const order = positions.get(parent) ?? 0;
                positions.set(parent, order + 1);
                return {
                    ...(folder.description === undefined
                        ? {}
                        : { description: folder.description }),
                    ...(folder.icon === undefined ? {} : { icon: folder.icon }),
                    id: folder.id,
                    name: folder.name,
                    order,
                    ...(folder.id === rootFolderId || folder.parentId === undefined
                        ? {}
                        : { parentId: folder.parentId }),
                    ...(folder.rules === undefined ? {} : { rules: folder.rules }),
                };
            }),
            rootId: rootFolderId,
        };
    }

    sharedFolderGroup(folderId: string): string | undefined {
        return queryFolderSharedGroup(this.#database, folderId);
    }

    sharedFolderRoot(groupId: string): string | undefined {
        return querySharedFolderRoot(this.#database, groupId);
    }

    assertFolderShareable(folderId: string): void {
        const problem = queryFolderShareRootProblem(this.#database, folderId);
        switch (problem) {
            case undefined:
            case "not_root":
                if (queryFolderSubtreeHasContents(this.#database, folderId)) {
                    throw new FolderError(
                        "shared_folder_contents_forbidden",
                        "A shared folder can contain only folders.",
                    );
                }
                return;
            case "missing":
                throw new FolderError("folder_not_found", "That folder was not found.");
            case "shared":
                throw new FolderError("shared_folder_boundary", "That folder is already shared.");
            case "contents":
                throw new FolderError(
                    "shared_folder_contents_forbidden",
                    "A shared folder can contain only folders.",
                );
        }
    }

    /** Pins an existing empty root to one Murmur group. */
    markFolderShared(folderId: string, groupId: string): Folder {
        if (this.sharedFolderGroup(folderId) === groupId) {
            const current = this.getFolder(folderId);
            if (current !== undefined) return current;
        }
        const result = this.#mutate((tx) => {
            const outcome = folderMarkShared(tx, folderId, groupId, this.#now());
            if (outcome.outcome === "marked") {
                this.#advanceAndPublish(tx, undefined, "update", folderId);
            }
            return outcome;
        });
        switch (result.outcome) {
            case "marked":
                return this.getFolder(folderId)!;
            case "folder_not_found":
                throw new FolderError("folder_not_found", "That folder was not found.");
            case "not_root":
                throw new FolderError(
                    "shared_folder_boundary",
                    "A shared folder must be at the root.",
                );
            case "contents_forbidden":
                throw new FolderError(
                    "shared_folder_contents_forbidden",
                    "A shared folder can contain only folders.",
                );
            case "group_conflict":
                throw new FolderError(
                    "shared_folder_boundary",
                    "That folder already belongs to another Murmur group.",
                );
        }
    }

    /**
     * Reconciles one Murmur group's virtual tree.
     *
     * Every ordinary repository mutation remains its own consistency boundary. A retry resumes from
     * the first unapplied node, while the Murmur delivery is acknowledged only after the final
     * state has landed.
     */
    applySharedFolderState(groupId: string, state: SharedFolderState): Folder {
        validateSharedFolderState(state);
        let rootId = this.sharedFolderRoot(groupId);
        const rootNode = state.folders[0]!;
        if (rootId === undefined) {
            if (this.getFolder(rootNode.id) !== undefined) {
                throw new FolderError(
                    "shared_folder_boundary",
                    "The incoming shared folder conflicts with a local folder.",
                );
            }
            this.createFolder(folderRequest(rootNode));
            this.markFolderShared(rootNode.id, groupId);
            rootId = rootNode.id;
        }
        if (rootId !== state.rootId) {
            throw new FolderError(
                "shared_folder_boundary",
                "The Murmur group changed its shared root identity.",
            );
        }

        const before = collectSubtree(this.listFolders(), rootId);
        const beforeIds = new Set(before.map((folder) => folder.id));
        for (const node of state.folders) {
            const current = this.getFolder(node.id);
            if (current === undefined) {
                this.createFolder(folderRequest(node));
                continue;
            }
            if (!beforeIds.has(node.id)) {
                throw new FolderError(
                    "shared_folder_boundary",
                    "The incoming shared tree conflicts with a local folder.",
                );
            }
            if (current.archivedAt !== undefined) {
                const siblings = queryFolderChildren(this.#database, node.parentId ?? null);
                const orderKey = generateKeyBetween(siblings.at(-1)?.orderKey ?? null, null);
                this.#mutate((tx) => {
                    if (
                        folderRestoreShared(tx, node.id, node.parentId!, orderKey, this.#now()) > 0
                    ) {
                        this.#advanceAndPublish(tx, undefined, "update", node.id);
                    }
                });
            }
            const active = this.getFolder(node.id)!;
            const patch = folderPatch(active, node);
            if (Object.keys(patch).length > 0) this.updateFolder(node.id, patch);
        }

        const children = new Map<string, SharedFolderNode[]>();
        for (const node of state.folders.slice(1)) {
            const siblings = children.get(node.parentId!);
            if (siblings === undefined) children.set(node.parentId!, [node]);
            else siblings.push(node);
        }
        for (const [parentId, siblings] of children) {
            siblings.sort(
                (left, right) => left.order - right.order || compareIds(left.id, right.id),
            );
            let afterId: string | null = null;
            for (const node of siblings) {
                const current = this.getFolder(node.id);
                if (current === undefined) continue;
                this.moveFolder(node.id, { afterId, parentId }, current.version);
                afterId = node.id;
            }
        }

        const incomingIds = new Set(state.folders.map((folder) => folder.id));
        const removed = collectSubtree(this.listFolders(), rootId).filter(
            (folder) => folder.id !== rootId && !incomingIds.has(folder.id),
        );
        const removedIds = new Set(removed.map((folder) => folder.id));
        for (const folder of removed) {
            if (folder.parentId !== undefined && removedIds.has(folder.parentId)) continue;
            this.archiveFolder(folder.id, folder.version);
        }
        return this.getFolder(rootId)!;
    }

    sessionScopeMutationApplied(sessionId: string, mutationId: string): boolean {
        const receipt = querySessionMutationReceipt(this.#database, {
            action: SESSION_SCOPE_MUTATION_ACTION,
            mutationId,
            sessionId,
        });
        if (receipt === "conflict") {
            throw new FolderError(
                "invalid_request",
                "That mutation ID was already used for another session change.",
            );
        }
        return receipt === "applied";
    }

    rememberSessionScopeMutation(sessionId: string, mutationId: string): void {
        this.#mutate((tx) => {
            const receipt = querySessionMutationReceipt(tx, {
                action: SESSION_SCOPE_MUTATION_ACTION,
                mutationId,
                sessionId,
            });
            if (receipt === "applied") return;
            if (receipt === "conflict") {
                throw new FolderError(
                    "invalid_request",
                    "That mutation ID was already used for another session change.",
                );
            }
            sessionRecordMutationReceipt(tx, {
                action: SESSION_SCOPE_MUTATION_ACTION,
                mutationId,
                now: this.#now(),
                sessionId,
            });
        });
    }

    /** Creates the private physical directory an explicitly Unsorted chat starts in. */
    createUnsortedSessionDirectory(sessionId: string): { created: boolean; path: string } {
        return this.#privateUnsortedDirectory(sessionId);
    }

    removeNewUnsortedSessionDirectory(sessionId: string, path: string): void {
        this.#removeEmptyPrivateDirectory(this.#unsortedDirectory, sessionId, path);
    }

    #createStorageDirectory(folderId: string): { created: boolean; path: string } {
        try {
            const root = this.#storageRoot();
            const path = join(root, folderId);
            let created = false;
            try {
                mkdirSync(path, { mode: 0o700 });
                created = true;
            } catch (error) {
                if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") {
                    throw error;
                }
            }
            return { created, path: this.#validateStorageDirectory(folderId, path, root) };
        } catch {
            throw new FolderError(
                "storage_unavailable",
                "The folder's storage directory could not be created.",
            );
        }
    }

    #validateStorageDirectory(folderId: string, path: string, knownRoot?: string): string {
        const root = knownRoot ?? this.#storageRoot();
        const stats = lstatSync(path);
        if (!stats.isDirectory() || stats.isSymbolicLink()) {
            throw new FolderError(
                "storage_unavailable",
                "The folder's storage directory is not a private directory.",
            );
        }
        const resolved = realpathSync(path);
        if (resolved !== join(root, folderId) || dirname(resolved) !== root) {
            throw new FolderError(
                "storage_unavailable",
                "The folder's storage directory is outside the folder storage root.",
            );
        }
        chmodSync(path, 0o700);
        return resolved;
    }

    #revalidateStorageDirectory(folder: Folder): string {
        try {
            return this.#validateStorageDirectory(folder.id, folder.path);
        } catch (error) {
            if (error instanceof FolderError) throw error;
            throw new FolderError(
                "storage_unavailable",
                "The folder's storage directory is unavailable.",
            );
        }
    }

    #storageRoot(): string {
        mkdirSync(this.#foldersDirectory, { mode: 0o700, recursive: true });
        const details = lstatSync(this.#foldersDirectory);
        if (!details.isDirectory() || details.isSymbolicLink()) {
            throw new FolderError(
                "storage_unavailable",
                "The folder storage root is not a private directory.",
            );
        }
        chmodSync(this.#foldersDirectory, 0o700);
        return realpathSync(this.#foldersDirectory);
    }

    #privateUnsortedDirectory(sessionId: string): { created: boolean; path: string } {
        mkdirSync(this.#unsortedDirectory, { mode: 0o700, recursive: true });
        const rootStats = lstatSync(this.#unsortedDirectory);
        if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
            throw new FolderError(
                "storage_unavailable",
                "The Unsorted storage root is not a private directory.",
            );
        }
        chmodSync(this.#unsortedDirectory, 0o700);
        const root = realpathSync(this.#unsortedDirectory);
        const path = join(root, sessionId);
        let created = false;
        try {
            mkdirSync(path, { mode: 0o700 });
            created = true;
        } catch (error) {
            if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") {
                throw error;
            }
        }
        const stats = lstatSync(path);
        const resolved = realpathSync(path);
        if (
            !stats.isDirectory() ||
            stats.isSymbolicLink() ||
            dirname(resolved) !== root ||
            resolved !== path
        ) {
            throw new FolderError(
                "storage_unavailable",
                "The Unsorted chat's working directory is not private.",
            );
        }
        chmodSync(resolved, 0o700);
        return { created, path: resolved };
    }

    #removeEmptyPrivateDirectory(rootPath: string, id: string, path: string): void {
        try {
            const rootStats = lstatSync(rootPath);
            if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) return;
            const root = realpathSync(rootPath);
            const stats = lstatSync(path);
            if (
                !stats.isDirectory() ||
                stats.isSymbolicLink() ||
                realpathSync(path) !== join(root, id)
            ) {
                return;
            }
            rmdirSync(path);
        } catch {
            // Cleanup is best effort and removes only the empty direct child this call created.
        }
    }

    #removeEmptyStorageDirectory(folderId: string, path: string): void {
        try {
            const root = this.#storageRoot();
            if (this.#validateStorageDirectory(folderId, path, root) !== path) return;
            rmdirSync(path);
        } catch {
            // The original database failure is authoritative. Cleanup only ever removes the empty
            // directory this call created and never retries through a changed filesystem boundary.
        }
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
        if (/\p{Cc}/u.test(name)) {
            throw new FolderError(
                "invalid_request",
                "A folder name cannot contain control characters.",
            );
        }
        return name;
    }

    #itemReceipt(
        mutationId: string | undefined,
        action: string,
        fingerprint: string,
    ): string | undefined {
        if (mutationId === undefined) return undefined;
        const receipt = queryFolderItemMutationReceipt(this.#database, mutationId);
        if (receipt === undefined) return undefined;
        if (receipt.action !== action || receipt.fingerprint !== fingerprint) {
            throw new FolderError(
                "invalid_request",
                "That mutation ID was already used for a different folder item change.",
            );
        }
        return receipt.itemId;
    }

    #recordItemReceipt(
        tx: TX,
        mutationId: string | undefined,
        action: string,
        fingerprint: string,
        itemId: string,
    ): void {
        if (mutationId === undefined) return;
        recordFolderItemMutationReceipt(tx, {
            action,
            fingerprint,
            itemId,
            mutationId,
            now: this.#now(),
        });
    }

    #folderIcon(requested: string): string {
        const icon = requested.trim();
        const graphemes = [
            ...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(icon),
        ];
        if (graphemes.length !== 1 || !/\p{Extended_Pictographic}/u.test(icon)) {
            throw new FolderError("invalid_request", "A folder icon must be one emoji.");
        }
        return icon;
    }

    #mutate<T>(body: (tx: TX) => T): T {
        if (this.#transactionRunner !== undefined) return this.#transactionRunner(body);
        return inTx(this.#database, body);
    }

    #advanceAndPublish(
        tx: TX,
        mutationId: string | undefined,
        action: FolderMutationAction,
        folderId: string,
    ): number {
        this.#recordMutation(tx, mutationId, action, folderId);
        const revision = advanceFolderCatalogRevision(tx);
        this.#onEvent?.({
            createdAt: this.#now(),
            data: {
                ...(mutationId === undefined ? {} : { mutationId }),
                revision,
            },
            id: this.#createEventId(),
            type: "folders_changed",
        });
        return revision;
    }

    #advanceItemAndPublish(tx: TX, mutationId: string | undefined): number {
        const revision = advanceFolderCatalogRevision(tx);
        this.#onEvent?.({
            createdAt: this.#now(),
            data: {
                ...(mutationId === undefined ? {} : { mutationId }),
                revision,
            },
            id: this.#createEventId(),
            type: "folders_changed",
        });
        return revision;
    }

    #rememberNoopMutation(
        mutationId: string | undefined,
        action: FolderMutationAction,
        folderId: string,
    ): void {
        if (mutationId === undefined) return;
        this.#mutate((tx) => {
            if (!this.#wasMutationApplied(tx, mutationId, action, folderId)) {
                this.#recordMutation(tx, mutationId, action, folderId);
            }
        });
    }

    #recordMutation(
        tx: TX,
        mutationId: string | undefined,
        action: FolderMutationAction,
        folderId: string,
    ): void {
        if (mutationId === undefined) return;
        tx.run(sql`
            INSERT INTO folder_mutations (mutation_id, action, folder_id, created_at_ms)
            VALUES (${mutationId}, ${action}, ${folderId}, ${this.#now()})
        `);
        tx.run(sql`
            DELETE FROM folder_mutations
            WHERE mutation_id IN (
                SELECT mutation_id
                FROM folder_mutations
                ORDER BY created_at_ms DESC, mutation_id DESC
                LIMIT -1 OFFSET ${MAX_FOLDER_MUTATION_RECEIPTS}
            )
        `);
    }

    #wasMutationApplied(
        tx: TX,
        mutationId: string | undefined,
        action: FolderMutationAction,
        folderId: string,
    ): boolean {
        if (mutationId === undefined) return false;
        const receipt = tx.get<{ action: string; folder_id: string }>(sql`
            SELECT action, folder_id
            FROM folder_mutations
            WHERE mutation_id = ${mutationId}
        `);
        if (receipt === undefined) return false;
        if (receipt.action !== action || receipt.folder_id !== folderId) {
            throw new FolderError(
                "invalid_request",
                "That mutation ID was already used for a different folder change.",
            );
        }
        return true;
    }

    #throwForCreateOutcome(outcome: FolderCreateResult): void {
        switch (outcome.outcome) {
            case "created":
                return;
            case "parent_not_found":
            case "parent_archived":
                throw new FolderError("parent_not_found", "That parent folder was not found.");
            case "id_conflict":
                throw new FolderError("invalid_request", "That folder ID is already in use.");
        }
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

export function validateSharedFolderState(state: SharedFolderState): void {
    if (state.folders.length > MAX_SHARED_FOLDER_NODES) {
        throw new FolderError("invalid_request", "A shared folder contains too many folders.");
    }
    if (state.folders[0]?.id !== state.rootId || state.folders[0]?.parentId !== undefined) {
        throw new FolderError(
            "invalid_request",
            "A shared folder snapshot must start with its root.",
        );
    }
    const known = new Set<string>();
    const positions = new Map<string, Set<number>>();
    for (const folder of state.folders) {
        if (known.has(folder.id)) {
            throw new FolderError(
                "invalid_request",
                "A shared folder snapshot contains the same folder twice.",
            );
        }
        if (
            folder.id !== state.rootId &&
            (folder.parentId === undefined || !known.has(folder.parentId))
        ) {
            throw new FolderError(
                "invalid_request",
                "A shared folder snapshot must place every parent before its children.",
            );
        }
        const parentId = folder.parentId ?? "";
        const siblingPositions = positions.get(parentId) ?? new Set<number>();
        if (siblingPositions.has(folder.order)) {
            throw new FolderError(
                "invalid_request",
                "A shared folder snapshot contains an ambiguous sibling order.",
            );
        }
        siblingPositions.add(folder.order);
        positions.set(parentId, siblingPositions);
        known.add(folder.id);
    }
}

function folderRequest(node: SharedFolderNode): CreateFolderRequest {
    return {
        ...(node.description === undefined ? {} : { description: node.description }),
        ...(node.icon === undefined ? {} : { icon: node.icon }),
        id: node.id,
        name: node.name,
        ...(node.parentId === undefined ? {} : { parentId: node.parentId }),
        ...(node.rules === undefined ? {} : { rules: node.rules }),
    };
}

function folderPatch(folder: Folder, node: SharedFolderNode): UpdateFolderRequest {
    return {
        ...(folder.description === node.description
            ? {}
            : { description: node.description ?? null }),
        ...(folder.icon === node.icon ? {} : { icon: node.icon ?? null }),
        ...(folder.name === node.name ? {} : { name: node.name }),
        ...(folder.rules === node.rules ? {} : { rules: node.rules ?? null }),
    };
}

function compareIds(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * The order key one drop lands on.
 *
 * `afterId` is the folder or item the folder was dropped below, and `null` means it landed first.
 * A drop that changes nothing keeps the key the folder already has.
 */
/**
 * Where a dropped folder lands among its new siblings.
 *
 * Ordering is the same fractional indexing every ordered list in Rig uses, so a drop is described
 * by the child it landed below and the key is derived from that, never sent by a client. A folder
 * dropped into another parent joins that parent's direct children first, since the key it carried
 * was only ever meaningful beside the children it used to sit with.
 */
function orderKeyForDrop(
    children: readonly FolderChildOrder[],
    folder: Folder,
    parentId: string | undefined,
    afterId: string | null,
): string {
    const siblings = children.filter((candidate) => candidate.id !== folder.id);
    // A folder arriving from another parent carries a key that only ever meant something beside the
    // children it used to sit with, so it joins the new row at the end and is placed from there.
    const arriving =
        parentId === folder.parentId
            ? folder
            : {
                  id: folder.id,
                  orderKey: generateKeyBetween(siblings.at(-1)?.orderKey ?? null, null),
              };
    try {
        return orderKeyAfter([...siblings, arriving], folder.id, afterId);
    } catch {
        throw new FolderError(
            "sibling_not_found",
            "The folder it was dropped below is not in that folder.",
        );
    }
}
