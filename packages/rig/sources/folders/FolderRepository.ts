import { chmodSync, lstatSync, mkdirSync, realpathSync, rmdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { createId } from "@paralleldrive/cuid2";
import type { Context } from "@steve.kite/stdlib";

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
import {
    queryFolderMutationReceipt,
    recordFolderMutationReceipt,
} from "../persistence/folder/folderMutationReceipt.js";
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
import { withDatabase } from "../persistence/database/databaseContext.js";
import { inTx } from "../persistence/inTx.js";
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
    onEvent?: (ctx: Context, event: FolderEvent) => void | Promise<void>;
    onFolderContextChanged?: (ctx: Context, folderIds: readonly string[]) => void | Promise<void>;
    onSessionsArchived?: (ctx: Context, sessionIds: readonly string[]) => void | Promise<void>;
    unsortedDirectory?: string;
    transaction?: <T>(ctx: Context, body: (ctx: Context) => Promise<T>) => Promise<T>;
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
    readonly #onEvent: ((ctx: Context, event: FolderEvent) => void | Promise<void>) | undefined;
    readonly #onFolderContextChanged:
        | ((ctx: Context, folderIds: readonly string[]) => void | Promise<void>)
        | undefined;
    readonly #onSessionsArchived:
        | ((ctx: Context, sessionIds: readonly string[]) => void | Promise<void>)
        | undefined;
    readonly #transactionRunner:
        | (<T>(ctx: Context, body: (ctx: Context) => Promise<T>) => Promise<T>)
        | undefined;
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
    async listFolders(ctx: Context): Promise<readonly Folder[]> {
        return queryFolders(withDatabase(ctx, this.#database.database));
    }

    async folderCatalog(ctx: Context): Promise<ListFoldersResponse> {
        return this.#mutate(ctx, async (transactionCtx) => {
            const items = await queryFolderItems(transactionCtx);
            return {
                folders: [...(await queryFolders(transactionCtx))],
                items: [...(await folderItemsWithActiveTargets(transactionCtx, items))],
                revision: await queryFolderCatalogRevision(transactionCtx),
            };
        });
    }

    async folderCatalogRevision(ctx: Context): Promise<number> {
        return queryFolderCatalogRevision(withDatabase(ctx, this.#database.database));
    }

    async getFolder(ctx: Context, folderId: string): Promise<Folder | undefined> {
        return queryFolder(withDatabase(ctx, this.#database.database), folderId);
    }

    async getFolderItem(ctx: Context, itemId: string): Promise<FolderItem | undefined> {
        return queryFolderItem(withDatabase(ctx, this.#database.database), itemId);
    }

    async createFolderItem(
        ctx: Context,
        folderId: string,
        request: CreateFolderItemRequest,
    ): Promise<FolderItem> {
        if ((await this.sharedFolderGroup(ctx, folderId)) !== undefined) {
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
        const applied = await this.#itemReceipt(ctx, request.mutationId, "create", fingerprint);
        if (applied !== undefined) {
            const item = await this.getFolderItem(ctx, applied);
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
        if ((await this.getFolderItem(ctx, id)) !== undefined) {
            throw new FolderError("invalid_request", "That folder item ID is already in use.");
        }
        if ((await this.getFolder(ctx, id)) !== undefined) {
            throw new FolderError("invalid_request", "That folder item ID is already in use.");
        }
        if (
            !(await queryFolderItemTargetExists(
                withDatabase(ctx, this.#database.database),
                request.target,
            ))
        ) {
            throw new FolderError("target_not_found", "That folder item target was not found.");
        }
        const siblings = await queryFolderChildren(
            withDatabase(ctx, this.#database.database),
            folderId,
        );
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
        return this.#mutate(ctx, async (transactionCtx) => {
            const outcome = await folderItemCreate(transactionCtx, {
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
            await this.#recordItemReceipt(
                transactionCtx,
                request.mutationId,
                "create",
                fingerprint,
                id,
            );
            await this.#advanceItemAndPublish(transactionCtx, request.mutationId);
            return (await queryFolderItem(transactionCtx, id))!;
        });
    }

    async moveFolderItem(
        ctx: Context,
        itemId: string,
        request: MoveFolderItemRequest,
        expectedVersion?: number,
    ): Promise<FolderItem | undefined> {
        const fingerprint = JSON.stringify({ expectedVersion, itemId, request });
        const applied = await this.#itemReceipt(ctx, request.mutationId, "move", fingerprint);
        if (applied !== undefined) return this.getFolderItem(ctx, applied);
        const current = await this.getFolderItem(ctx, itemId);
        if (current === undefined || current.archivedAt !== undefined) return undefined;
        if (expectedVersion !== undefined && current.version !== expectedVersion) {
            throw new FolderError("version_conflict", "The folder item changed before it moved.");
        }
        if ((await this.sharedFolderGroup(ctx, request.folderId)) !== undefined) {
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
        const siblings = (
            await queryFolderChildren(withDatabase(ctx, this.#database.database), request.folderId)
        ).filter((child) => child.id !== itemId);
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
            await this.#mutate(ctx, async (transactionCtx) =>
                this.#recordItemReceipt(
                    transactionCtx,
                    request.mutationId,
                    "move",
                    fingerprint,
                    itemId,
                ),
            );
            return current;
        }
        return this.#mutate(ctx, async (transactionCtx) => {
            const outcome = await folderItemMove(
                transactionCtx,
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
            await this.#recordItemReceipt(
                transactionCtx,
                request.mutationId,
                "move",
                fingerprint,
                itemId,
            );
            await this.#advanceItemAndPublish(transactionCtx, request.mutationId);
            return queryFolderItem(transactionCtx, itemId);
        });
    }

    async archiveFolderItem(
        ctx: Context,
        itemId: string,
        expectedVersion?: number,
        mutationId?: string,
    ): Promise<FolderItem | undefined> {
        const fingerprint = JSON.stringify({ expectedVersion, itemId });
        const applied = await this.#itemReceipt(ctx, mutationId, "archive", fingerprint);
        if (applied !== undefined) return this.getFolderItem(ctx, applied);
        const current = await this.getFolderItem(ctx, itemId);
        if (current === undefined) return undefined;
        if (expectedVersion !== undefined && current.version !== expectedVersion) {
            throw new FolderError(
                "version_conflict",
                "The folder item changed before it was archived.",
            );
        }
        if (current.archivedAt !== undefined) {
            await this.#mutate(ctx, async (transactionCtx) =>
                this.#recordItemReceipt(transactionCtx, mutationId, "archive", fingerprint, itemId),
            );
            return current;
        }
        return this.#mutate(ctx, async (transactionCtx) => {
            const changed = await folderItemArchive(
                transactionCtx,
                itemId,
                this.#now(),
                expectedVersion,
            );
            if (changed === 0) {
                throw new FolderError(
                    "version_conflict",
                    "The folder item changed before it was archived.",
                );
            }
            await this.#recordItemReceipt(
                transactionCtx,
                mutationId,
                "archive",
                fingerprint,
                itemId,
            );
            await this.#advanceItemAndPublish(transactionCtx, mutationId);
            return queryFolderItem(transactionCtx, itemId);
        });
    }

    /** Resolves one active folder through its enforced flat-storage boundary. */
    async activeFolderStoragePath(ctx: Context, folderId: string): Promise<string> {
        const folder = await this.getFolder(ctx, folderId);
        if (folder === undefined || folder.archivedAt !== undefined) {
            throw new FolderError("folder_not_found", "That folder was not found.");
        }
        if ((await this.sharedFolderGroup(ctx, folderId)) !== undefined) {
            throw new FolderError(
                "shared_folder_contents_forbidden",
                "A shared folder can contain only folders.",
            );
        }
        return this.#revalidateStorageDirectory(folder);
    }

    /** Revalidates persisted storage even when its virtual folder is already archived. */
    async folderStoragePath(ctx: Context, folderId: string): Promise<string> {
        const folder = await this.getFolder(ctx, folderId);
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
    async createFolder(ctx: Context, request: CreateFolderRequest): Promise<Folder> {
        const id = this.#folderId(request.id);
        if (
            await this.#wasMutationApplied(
                withDatabase(ctx, this.#database.database),
                request.mutationId,
                "create",
                id,
            )
        ) {
            const applied = await this.getFolder(ctx, id);
            if (applied !== undefined) return applied;
        }
        const existing = await this.getFolder(ctx, id);
        if (existing !== undefined) {
            this.#validateStorageDirectory(id, existing.path);
            await this.#rememberNoopMutation(ctx, request.mutationId, "create", id);
            return existing;
        }
        if ((await this.getFolderItem(ctx, id)) !== undefined) {
            throw new FolderError("invalid_request", "That folder ID is already in use.");
        }
        const name = this.#folderName(request.name);
        if (request.parentId !== undefined) {
            const parent = await this.getFolder(ctx, request.parentId);
            if (parent === undefined || parent.archivedAt !== undefined) {
                throw new FolderError("parent_not_found", "That parent folder was not found.");
            }
            const sharedGroupId = await this.sharedFolderGroup(ctx, request.parentId);
            const sharedRootId =
                sharedGroupId === undefined
                    ? undefined
                    : await this.sharedFolderRoot(ctx, sharedGroupId);
            if (
                sharedRootId !== undefined &&
                (await this.sharedFolderState(ctx, sharedRootId)).folders.length >=
                    MAX_SHARED_FOLDER_NODES
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
            created = await this.#mutate(ctx, async (transactionCtx) => {
                const outcome = await folderCreate(transactionCtx, {
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
                const created = await queryFolder(transactionCtx, id);
                if (created === undefined) {
                    throw new FolderError(
                        "folder_not_found",
                        "The new folder could not be read back.",
                    );
                }
                await this.#advanceAndPublish(transactionCtx, request.mutationId, "create", id);
                return created;
            });
        } catch (error) {
            if (storage.created) this.#removeEmptyStorageDirectory(id, storage.path);
            throw error;
        }
        return created;
    }

    async updateFolder(
        ctx: Context,
        folderId: string,
        request: UpdateFolderRequest,
        expectedVersion?: number,
    ): Promise<Folder | undefined> {
        if (
            await this.#wasMutationApplied(
                withDatabase(ctx, this.#database.database),
                request.mutationId,
                "update",
                folderId,
            )
        ) {
            return this.getFolder(ctx, folderId);
        }
        const current = await this.getFolder(ctx, folderId);
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
            await this.#rememberNoopMutation(ctx, request.mutationId, "update", folderId);
            return current;
        }
        const updated = await this.#mutate(ctx, async (transactionCtx) => {
            const changed = await folderUpdate(
                transactionCtx,
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
                return queryFolder(transactionCtx, folderId);
            }
            const folder = await queryFolder(transactionCtx, folderId);
            await this.#advanceAndPublish(transactionCtx, request.mutationId, "update", folderId);
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
                        : collectSubtree(await this.listFolders(ctx), folderId).map(
                              (folder) => folder.id,
                          );
                await this.#onFolderContextChanged?.(ctx, affected);
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
    async moveFolder(
        ctx: Context,
        folderId: string,
        request: MoveFolderRequest,
        expectedVersion?: number,
    ): Promise<Folder | undefined> {
        if (
            await this.#wasMutationApplied(
                withDatabase(ctx, this.#database.database),
                request.mutationId,
                "move",
                folderId,
            )
        ) {
            return this.getFolder(ctx, folderId);
        }
        const folders = await this.listFolders(ctx);
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
                (await this.sharedFolderGroup(ctx, parentId)) !== undefined &&
                (await queryFolderSubtreeHasContents(
                    withDatabase(ctx, this.#database.database),
                    folderId,
                ))
            ) {
                throw new FolderError(
                    "shared_folder_contents_forbidden",
                    "A shared folder can contain only folders.",
                );
            }
            const targetGroupId = await this.sharedFolderGroup(ctx, parentId);
            const currentGroupId = await this.sharedFolderGroup(ctx, folderId);
            const targetRootId =
                targetGroupId === undefined
                    ? undefined
                    : await this.sharedFolderRoot(ctx, targetGroupId);
            if (targetRootId !== undefined && targetGroupId !== currentGroupId) {
                const arrivingCount = collectSubtree(folders, folderId).filter(
                    (folder) => folder.archivedAt === undefined,
                ).length;
                if (
                    (await this.sharedFolderState(ctx, targetRootId)).folders.length +
                        arrivingCount >
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
            await queryFolderChildren(withDatabase(ctx, this.#database.database), parentId ?? null),
            current,
            parentId,
            request.afterId,
        );
        if (parentId === current.parentId && orderKey === current.orderKey) {
            await this.#rememberNoopMutation(ctx, request.mutationId, "move", folderId);
            return current;
        }
        const moved = await this.#mutate(ctx, async (transactionCtx) => {
            const outcome = await folderMove(
                transactionCtx,
                folderId,
                request.parentId,
                orderKey,
                this.#now(),
                expectedVersion,
            );
            switch (outcome.outcome) {
                case "moved":
                    const folder = await queryFolder(transactionCtx, folderId);
                    await this.#advanceAndPublish(
                        transactionCtx,
                        request.mutationId,
                        "move",
                        folderId,
                    );
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
                    return queryFolder(transactionCtx, folderId);
            }
        });
        if (moved !== undefined && parentId !== current.parentId) {
            await this.#onFolderContextChanged?.(
                ctx,
                collectSubtree(await this.listFolders(ctx), folderId).map((folder) => folder.id),
            );
        }
        return moved;
    }

    /** Puts a folder away together with everything nested under it. */
    async archiveFolder(
        ctx: Context,
        folderId: string,
        expectedVersion?: number,
        mutationId?: string,
    ): Promise<Folder | undefined> {
        if (
            await this.#wasMutationApplied(
                withDatabase(ctx, this.#database.database),
                mutationId,
                "archive",
                folderId,
            )
        ) {
            return this.getFolder(ctx, folderId);
        }
        const folders = await this.listFolders(ctx);
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
            await this.#rememberNoopMutation(ctx, mutationId, "archive", folderId);
            return folder;
        }
        let archivedSessionIds: readonly string[] = [];
        const result = await this.#mutate(ctx, async (transactionCtx) => {
            archivedSessionIds = (await folderArchive(transactionCtx, folderId, this.#now()))
                .sessionIds;
            await this.#advanceAndPublish(transactionCtx, mutationId, "archive", folderId);
            return queryFolder(transactionCtx, folderId);
        });
        await this.#onSessionsArchived?.(ctx, archivedSessionIds);
        return result;
    }

    /** Files one chat into a folder, or takes it back out into Unsorted with `null`. */
    async setSessionFolder(
        ctx: Context,
        sessionId: string,
        folderId: string | null,
        afterId?: string | null,
        mutationId?: string,
    ): Promise<SessionScopeMove> {
        const now = this.#now();
        if (folderId === null) {
            const storage = this.#privateUnsortedDirectory(sessionId);
            try {
                return await this.#mutate(ctx, (transactionCtx) =>
                    sessionMoveScope(transactionCtx, {
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
                    this.removeNewUnsortedSessionDirectory(ctx, sessionId, storage.path);
                }
                throw error;
            }
        }
        if ((await this.sharedFolderGroup(ctx, folderId)) !== undefined) {
            throw new FolderError(
                "shared_folder_contents_forbidden",
                "A shared folder can contain only folders.",
            );
        }
        const path = await this.activeFolderStoragePath(ctx, folderId);
        return this.#mutate(ctx, (transactionCtx) =>
            sessionMoveScope(transactionCtx, {
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
    async sharedFolderState(ctx: Context, rootFolderId: string): Promise<SharedFolderState> {
        const folders = collectSubtree(await this.listFolders(ctx), rootFolderId).filter(
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

    async sharedFolderGroup(ctx: Context, folderId: string): Promise<string | undefined> {
        return await queryFolderSharedGroup(withDatabase(ctx, this.#database.database), folderId);
    }

    async sharedFolderRoot(ctx: Context, groupId: string): Promise<string | undefined> {
        return await querySharedFolderRoot(withDatabase(ctx, this.#database.database), groupId);
    }

    async assertFolderShareable(ctx: Context, folderId: string): Promise<void> {
        const problem = await queryFolderShareRootProblem(
            withDatabase(ctx, this.#database.database),
            folderId,
        );
        switch (problem) {
            case undefined:
            case "not_root":
                if (
                    await queryFolderSubtreeHasContents(
                        withDatabase(ctx, this.#database.database),
                        folderId,
                    )
                ) {
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
    async markFolderShared(ctx: Context, folderId: string, groupId: string): Promise<Folder> {
        if ((await this.sharedFolderGroup(ctx, folderId)) === groupId) {
            const current = await this.getFolder(ctx, folderId);
            if (current !== undefined) return current;
        }
        const result = await this.#mutate(ctx, async (transactionCtx) => {
            const outcome = await folderMarkShared(transactionCtx, folderId, groupId, this.#now());
            if (outcome.outcome === "marked") {
                await this.#advanceAndPublish(transactionCtx, undefined, "update", folderId);
            }
            return outcome;
        });
        switch (result.outcome) {
            case "marked":
                return (await this.getFolder(ctx, folderId))!;
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
    async applySharedFolderState(
        ctx: Context,
        groupId: string,
        state: SharedFolderState,
    ): Promise<Folder> {
        validateSharedFolderState(state);
        let rootId = await this.sharedFolderRoot(ctx, groupId);
        const rootNode = state.folders[0]!;
        if (rootId === undefined) {
            if ((await this.getFolder(ctx, rootNode.id)) !== undefined) {
                throw new FolderError(
                    "shared_folder_boundary",
                    "The incoming shared folder conflicts with a local folder.",
                );
            }
            await this.createFolder(ctx, folderRequest(rootNode));
            await this.markFolderShared(ctx, rootNode.id, groupId);
            rootId = rootNode.id;
        }
        if (rootId !== state.rootId) {
            throw new FolderError(
                "shared_folder_boundary",
                "The Murmur group changed its shared root identity.",
            );
        }

        const before = collectSubtree(await this.listFolders(ctx), rootId);
        const beforeIds = new Set(before.map((folder) => folder.id));
        for (const node of state.folders) {
            const current = await this.getFolder(ctx, node.id);
            if (current === undefined) {
                await this.createFolder(ctx, folderRequest(node));
                continue;
            }
            if (!beforeIds.has(node.id)) {
                throw new FolderError(
                    "shared_folder_boundary",
                    "The incoming shared tree conflicts with a local folder.",
                );
            }
            if (current.archivedAt !== undefined) {
                const siblings = await queryFolderChildren(
                    withDatabase(ctx, this.#database.database),
                    node.parentId ?? null,
                );
                const orderKey = generateKeyBetween(siblings.at(-1)?.orderKey ?? null, null);
                await this.#mutate(ctx, async (transactionCtx) => {
                    if (
                        (await folderRestoreShared(
                            transactionCtx,
                            node.id,
                            node.parentId!,
                            orderKey,
                            this.#now(),
                        )) > 0
                    ) {
                        await this.#advanceAndPublish(transactionCtx, undefined, "update", node.id);
                    }
                });
            }
            const active = (await this.getFolder(ctx, node.id))!;
            const patch = folderPatch(active, node);
            if (Object.keys(patch).length > 0) await this.updateFolder(ctx, node.id, patch);
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
                const current = await this.getFolder(ctx, node.id);
                if (current === undefined) continue;
                await this.moveFolder(ctx, node.id, { afterId, parentId }, current.version);
                afterId = node.id;
            }
        }

        const incomingIds = new Set(state.folders.map((folder) => folder.id));
        const removed = collectSubtree(await this.listFolders(ctx), rootId).filter(
            (folder) => folder.id !== rootId && !incomingIds.has(folder.id),
        );
        const removedIds = new Set(removed.map((folder) => folder.id));
        for (const folder of removed) {
            if (folder.parentId !== undefined && removedIds.has(folder.parentId)) continue;
            await this.archiveFolder(ctx, folder.id, folder.version);
        }
        return (await this.getFolder(ctx, rootId))!;
    }

    async sessionScopeMutationApplied(
        ctx: Context,
        sessionId: string,
        mutationId: string,
    ): Promise<boolean> {
        const receipt = await querySessionMutationReceipt(
            withDatabase(ctx, this.#database.database),
            {
                action: SESSION_SCOPE_MUTATION_ACTION,
                mutationId,
                sessionId,
            },
        );
        if (receipt === "conflict") {
            throw new FolderError(
                "invalid_request",
                "That mutation ID was already used for another session change.",
            );
        }
        return receipt === "applied";
    }

    async rememberSessionScopeMutation(
        ctx: Context,
        sessionId: string,
        mutationId: string,
    ): Promise<void> {
        await this.#mutate(ctx, async (transactionCtx) => {
            const receipt = await querySessionMutationReceipt(transactionCtx, {
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
            await sessionRecordMutationReceipt(transactionCtx, {
                action: SESSION_SCOPE_MUTATION_ACTION,
                mutationId,
                now: this.#now(),
                sessionId,
            });
        });
    }

    /** Creates the private physical directory an explicitly Unsorted chat starts in. */
    createUnsortedSessionDirectory(
        _ctx: Context,
        sessionId: string,
    ): { created: boolean; path: string } {
        return this.#privateUnsortedDirectory(sessionId);
    }

    removeNewUnsortedSessionDirectory(_ctx: Context, sessionId: string, path: string): void {
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

    async #itemReceipt(
        ctx: Context,
        mutationId: string | undefined,
        action: string,
        fingerprint: string,
    ): Promise<string | undefined> {
        if (mutationId === undefined) return undefined;
        const receipt = await queryFolderItemMutationReceipt(
            withDatabase(ctx, this.#database.database),
            mutationId,
        );
        if (receipt === undefined) return undefined;
        if (receipt.action !== action || receipt.fingerprint !== fingerprint) {
            throw new FolderError(
                "invalid_request",
                "That mutation ID was already used for a different folder item change.",
            );
        }
        return receipt.itemId;
    }

    async #recordItemReceipt(
        ctx: Context,
        mutationId: string | undefined,
        action: string,
        fingerprint: string,
        itemId: string,
    ): Promise<void> {
        if (mutationId === undefined) return;
        await recordFolderItemMutationReceipt(ctx, {
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

    async #mutate<T>(ctx: Context, body: (ctx: Context) => Promise<T>): Promise<T> {
        if (this.#transactionRunner !== undefined) return this.#transactionRunner(ctx, body);
        return inTx(
            withDatabase(ctx, this.#database),
            "rig.sql.folder.repositoryTransaction",
            body,
        );
    }

    async #advanceAndPublish(
        ctx: Context,
        mutationId: string | undefined,
        action: FolderMutationAction,
        folderId: string,
    ): Promise<number> {
        await this.#recordMutation(ctx, mutationId, action, folderId);
        const revision = await advanceFolderCatalogRevision(ctx);
        await this.#onEvent?.(ctx, {
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

    async #advanceItemAndPublish(ctx: Context, mutationId: string | undefined): Promise<number> {
        const revision = await advanceFolderCatalogRevision(ctx);
        await this.#onEvent?.(ctx, {
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

    async #rememberNoopMutation(
        ctx: Context,
        mutationId: string | undefined,
        action: FolderMutationAction,
        folderId: string,
    ): Promise<void> {
        if (mutationId === undefined) return;
        await this.#mutate(ctx, async (transactionCtx) => {
            if (!(await this.#wasMutationApplied(transactionCtx, mutationId, action, folderId))) {
                await this.#recordMutation(transactionCtx, mutationId, action, folderId);
            }
        });
    }

    async #recordMutation(
        ctx: Context,
        mutationId: string | undefined,
        action: FolderMutationAction,
        folderId: string,
    ): Promise<void> {
        if (mutationId === undefined) return;
        await recordFolderMutationReceipt(ctx, {
            action,
            folderId,
            mutationId,
            now: this.#now(),
        });
    }

    async #wasMutationApplied(
        ctx: Context,
        mutationId: string | undefined,
        action: FolderMutationAction,
        folderId: string,
    ): Promise<boolean> {
        if (mutationId === undefined) return false;
        const receipt = await queryFolderMutationReceipt(ctx, mutationId);
        if (receipt === undefined) return false;
        if (receipt.action !== action || receipt.folderId !== folderId) {
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
