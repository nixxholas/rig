import type {
    CreateMurmurSessionOptions,
    MurmurService,
    MurmurServiceSessionDescriptor,
    MurmurSession,
    MurmurSessionListOptions,
    MurmurSessionPage,
    MurmurUpdate,
} from "@slopus/murmur";
import { Value } from "@sinclair/typebox/value";

import {
    folderShareDescriptorSchema,
    folderSharePacketSchema,
    type FolderShareDescriptor,
    type FolderSharePacket,
    type FolderShareStatus,
    type SharedFolderState,
} from "../protocol/index.js";
import type { TX } from "../persistence/Transaction.js";
import { folderShareCreate } from "../persistence/folderShare/folderShareCreate.js";
import {
    FolderShareSemanticError,
    folderShareRecordAppliedState,
    folderShareRecordRejectedState,
    folderShareShouldApplyState,
} from "../persistence/folderShare/folderShareApplyState.js";
import {
    folderShareDeleteIntent,
    folderSharePutIntent,
    queryFolderShareIntentByRoot,
    queryFolderShareIntents,
} from "../persistence/folderShare/folderShareIntent.js";
import {
    folderShareOutboxFailed,
    folderShareOutboxSent,
} from "../persistence/folderShare/folderShareOutbox.js";
import { folderShareQueueState } from "../persistence/folderShare/folderShareQueueState.js";
import {
    queryFolderShare,
    queryFolderShareByShareId,
    queryFolderShares,
    queryPendingFolderShareOutbox,
} from "../persistence/folderShare/queryFolderShares.js";
import type { Folder, MoveFolderRequest } from "../protocol/index.js";
import { createEventIdFactory } from "../protocol/createEventIdFactory.js";
import { FolderError, validateSharedFolderState } from "../folders/FolderRepository.js";
import { isDatabaseFailure } from "../persistence/isDatabaseFailure.js";

export const FOLDER_SHARING_MURMUR_SERVICE_ID = "rig.folder-share.v1";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const MAX_MURMUR_APPLICATION_BYTES = 1024 * 1024;

interface FolderSharingDatabase {
    query<Result>(operation: (tx: TX) => Result): Result;
    transaction<Result>(operation: (tx: TX) => Result): Result;
}

export interface FolderSharingStore {
    applySharedFolderState(groupId: string, state: SharedFolderState): Folder;
    assertFolderShareable(folderId: string): void;
    getFolder(folderId: string): Folder | undefined;
    markFolderShared(folderId: string, groupId: string): Folder;
    moveFolder(
        folderId: string,
        request: MoveFolderRequest,
        expectedVersion?: number,
    ): Folder | undefined;
    sharedFolderGroup(folderId: string): string | undefined;
    sharedFolderState(rootFolderId: string): SharedFolderState;
}

export interface FolderSharingMurmurClient {
    readonly identity: Uint8Array;
    createSession(options: CreateMurmurSessionOptions): Promise<MurmurSession>;
    send(id: Uint8Array, bytes: Uint8Array): Promise<string>;
    session(id: Uint8Array): Promise<MurmurSession | undefined>;
    sessions(options?: MurmurSessionListOptions): Promise<MurmurSessionPage>;
}

export interface FolderSharingServiceOptions {
    database: FolderSharingDatabase;
    folders: FolderSharingStore;
    now?: () => number;
    onChanged: () => void;
    onError?: (error: unknown) => void;
}

/**
 * Rig's typed Murmur service for shared virtual folder trees.
 *
 * Murmur owns encrypted group delivery. This service owns the tree snapshot, deterministic
 * application ordering, replay receipts, and the durable application outbox.
 */
export class FolderSharingService implements MurmurService {
    readonly #applying = new Set<string>();
    readonly #database: FolderSharingDatabase;
    readonly #folders: FolderSharingStore;
    readonly #nextOperationId: () => string;
    readonly #now: () => number;
    readonly #onChanged: () => void;
    readonly #onError: (error: unknown) => void;
    #client: FolderSharingMurmurClient | undefined;
    #drain: Promise<void> | undefined;

    constructor(options: FolderSharingServiceOptions) {
        this.#database = options.database;
        this.#folders = options.folders;
        this.#now = options.now ?? Date.now;
        this.#nextOperationId = createEventIdFactory({ now: this.#now });
        this.#onChanged = options.onChanged;
        this.#onError = options.onError ?? (() => undefined);
    }

    attach(client: FolderSharingMurmurClient): void {
        if (this.#client !== undefined && this.#client !== client) {
            throw new Error("Folder Sharing is already attached to Murmur.");
        }
        this.#client = client;
    }

    async create(rootFolderId: string, contacts: readonly string[]): Promise<FolderShareStatus> {
        const client = this.#requireClient();
        await this.recover();
        const recoveredGroupId = this.#folders.sharedFolderGroup(rootFolderId);
        if (recoveredGroupId !== undefined) {
            return this.#status(
                recoveredGroupId,
                await client.session(decodeIdentity(recoveredGroupId)),
            );
        }
        this.#folders.assertFolderShareable(rootFolderId);
        const existingIntent = this.#database.query((tx) =>
            queryFolderShareIntentByRoot(tx, rootFolderId),
        );
        const state = existingIntent?.state ?? this.#folders.sharedFolderState(rootFolderId);
        validateSharedFolderState(state);
        const shareId = existingIntent?.shareId ?? this.#nextOperationId();
        const descriptor: FolderShareDescriptor = {
            kind: "folder_share",
            shareId,
            state,
            version: 1,
        };
        const descriptorBytes = encodeJson(descriptor);
        if (descriptorBytes.length > MAX_MURMUR_APPLICATION_BYTES) {
            throw new Error("That folder tree is too large to share through Murmur.");
        }
        if (existingIntent === undefined) {
            this.#database.transaction((tx) =>
                folderSharePutIntent(tx, {
                    now: this.#now(),
                    rootFolderId,
                    shareId,
                    state,
                }),
            );
        }
        const group = await client.createSession({
            contacts: contacts.map(decodeIdentity),
            descriptor: descriptorBytes,
            service: FOLDER_SHARING_MURMUR_SERVICE_ID,
        });
        const groupId = this.#completeCreatedShare(group, descriptor);
        this.#onChanged();
        return this.#status(groupId, group);
    }

    async onNewSession(session: MurmurServiceSessionDescriptor): Promise<boolean> {
        const descriptor = decodeDescriptor(session.descriptor);
        if (descriptor === undefined) return false;
        const groupId = encodeBytes(session.id);
        try {
            validateSharedFolderState(descriptor.state);
        } catch {
            return false;
        }
        if (
            this.#database.query((tx) => queryFolderShareByShareId(tx, descriptor.shareId)) !==
            undefined
        ) {
            return false;
        }
        this.#applying.add(groupId);
        try {
            this.#database.transaction((tx) => {
                this.#folders.applySharedFolderState(groupId, descriptor.state);
                folderShareCreate(tx, {
                    groupId,
                    now: this.#now(),
                    rootFolderId: descriptor.state.rootId,
                    shareId: descriptor.shareId,
                    sender: encodeBytes(session.committer),
                    state: descriptor.state,
                    status: "synced",
                });
            });
        } catch (error) {
            if (error instanceof FolderError && error.code !== "storage_unavailable") return false;
            throw error;
        } finally {
            this.#applying.delete(groupId);
        }
        this.#onChanged();
        return true;
    }

    async onUpdate(update: MurmurUpdate): Promise<void> {
        const packet = decodePacket(update.bytes);
        if (packet === undefined) return;
        const groupId = encodeBytes(update.sessionId);
        const sender = encodeBytes(update.sender);
        if (this.#database.query((tx) => queryFolderShare(tx, groupId)) === undefined) return;
        const outcome = this.#database.query((tx) =>
            folderShareShouldApplyState(tx, groupId, update.id, packet),
        );
        if (outcome !== "apply") return;
        this.#applying.add(groupId);
        try {
            this.#database.transaction((tx) => {
                const state = folderShareRecordAppliedState(tx, {
                    deliveryId: update.id,
                    groupId,
                    now: this.#now(),
                    packet,
                    sender,
                });
                this.#folders.applySharedFolderState(groupId, state);
            });
        } catch (error) {
            if (isDatabaseFailure(error)) throw error;
            if (
                !(error instanceof FolderShareSemanticError) &&
                !(error instanceof FolderError && error.code !== "storage_unavailable")
            ) {
                throw error;
            }
            this.#database.transaction((tx) =>
                folderShareRecordRejectedState(tx, {
                    deliveryId: update.id,
                    error:
                        error instanceof Error
                            ? error.message
                            : "The folder update could not be applied.",
                    groupId,
                    now: this.#now(),
                    packet,
                    sender,
                }),
            );
        } finally {
            this.#applying.delete(groupId);
        }
        this.#onChanged();
    }

    /** Reconciles creator-owned Murmur sessions left between durable creation steps. */
    async recover(): Promise<void> {
        const client = this.#requireClient();
        const intents = new Map(
            this.#database.query(queryFolderShareIntents).map((intent) => [intent.shareId, intent]),
        );
        if (intents.size === 0) return;
        let after: string | undefined;
        do {
            const page = await client.sessions({ ...(after === undefined ? {} : { after }) });
            for (const session of page.sessions) {
                const descriptor = decodeDescriptor(session.descriptor);
                const intent =
                    descriptor === undefined ? undefined : intents.get(descriptor.shareId);
                if (
                    descriptor === undefined ||
                    intent === undefined ||
                    intent.rootFolderId !== descriptor.state.rootId
                ) {
                    continue;
                }
                validateSharedFolderState(descriptor.state);
                this.#completeCreatedShare(session, descriptor);
                intents.delete(descriptor.shareId);
            }
            after = page.cursor ?? undefined;
        } while (after !== undefined);
        this.foldersChanged();
    }

    /** Observes the already-committed local folder catalog and queues changed share snapshots. */
    foldersChanged(): void {
        const client = this.#client;
        if (client === undefined) return;
        try {
            for (const share of this.#database.query(queryFolderShares)) {
                if (this.#applying.has(share.groupId)) continue;
                const state = this.#folders.sharedFolderState(share.rootFolderId);
                validateSharedFolderState(state);
                this.#database.transaction((tx) =>
                    folderShareQueueState(tx, {
                        groupId: share.groupId,
                        now: this.#now(),
                        operationId: this.#nextOperationId(),
                        sender: encodeBytes(client.identity),
                        state,
                    }),
                );
            }
            this.#scheduleDrain();
        } catch (error) {
            this.#onError(error);
        }
    }

    async statuses(): Promise<FolderShareStatus[]> {
        const client = this.#requireClient();
        const results: FolderShareStatus[] = [];
        for (const share of this.#database.query(queryFolderShares)) {
            results.push(
                this.#status(share.groupId, await client.session(decodeIdentity(share.groupId))),
            );
        }
        return results;
    }

    drain(): Promise<void> {
        this.#drain ??= this.#finishDrain().finally(() => {
            this.#drain = undefined;
        });
        return this.#drain;
    }

    async #finishDrain(): Promise<void> {
        const client = this.#requireClient();
        while (true) {
            const pending = this.#database.query(queryPendingFolderShareOutbox)[0];
            if (pending === undefined) return;
            try {
                await client.send(
                    decodeIdentity(pending.groupId),
                    encoder.encode(pending.payloadJson),
                );
                this.#database.transaction((tx) => folderShareOutboxSent(tx, pending.operationId));
                this.#onChanged();
            } catch (error) {
                this.#database.transaction((tx) =>
                    folderShareOutboxFailed(
                        tx,
                        pending.operationId,
                        error instanceof Error ? error.message : "Folder synchronization failed.",
                        this.#now(),
                    ),
                );
                this.#onChanged();
                throw error;
            }
        }
    }

    #scheduleDrain(): void {
        void this.drain().catch(this.#onError);
    }

    #status(groupId: string, session: MurmurSession | undefined): FolderShareStatus {
        const share = this.#database.query((tx) => queryFolderShare(tx, groupId));
        if (share === undefined) throw new Error("The shared folder group is unknown.");
        return {
            ...(share.error === undefined ? {} : { error: share.error }),
            groupId,
            ...(share.lastSyncedAt === undefined ? {} : { lastSyncedAt: share.lastSyncedAt }),
            members: session?.members.map(encodeBytes) ?? [],
            rootFolderId: share.rootFolderId,
            status: share.status,
        };
    }

    #completeCreatedShare(group: MurmurSession, descriptor: FolderShareDescriptor): string {
        const groupId = encodeBytes(group.id);
        const client = this.#requireClient();
        this.#database.transaction((tx) => {
            const root = this.#folders.getFolder(descriptor.state.rootId);
            if (root === undefined) throw new Error("The folder disappeared before it was shared.");
            if (root.parentId !== undefined) {
                this.#folders.moveFolder(
                    descriptor.state.rootId,
                    { afterId: null, parentId: null },
                    root.version,
                );
            }
            this.#folders.markFolderShared(descriptor.state.rootId, groupId);
            folderShareCreate(tx, {
                groupId,
                now: this.#now(),
                rootFolderId: descriptor.state.rootId,
                shareId: descriptor.shareId,
                sender: encodeBytes(client.identity),
                state: descriptor.state,
                status: "syncing",
            });
            folderShareDeleteIntent(tx, descriptor.shareId);
        });
        this.#queueCurrentState(groupId, descriptor.state.rootId, true);
        return groupId;
    }

    #queueCurrentState(groupId: string, rootFolderId: string, force: boolean): void {
        const client = this.#requireClient();
        const state = this.#folders.sharedFolderState(rootFolderId);
        validateSharedFolderState(state);
        this.#database.transaction((tx) =>
            folderShareQueueState(tx, {
                force,
                groupId,
                now: this.#now(),
                operationId: this.#nextOperationId(),
                sender: encodeBytes(client.identity),
                state,
            }),
        );
        this.#scheduleDrain();
    }

    #requireClient(): FolderSharingMurmurClient {
        if (this.#client === undefined)
            throw new Error("Folder Sharing is not connected to Murmur.");
        return this.#client;
    }
}

function decodeDescriptor(bytes: Uint8Array): FolderShareDescriptor | undefined {
    const value = decodeJson(bytes);
    return Value.Check(folderShareDescriptorSchema, value)
        ? (value as FolderShareDescriptor)
        : undefined;
}

function decodePacket(bytes: Uint8Array): FolderSharePacket | undefined {
    const value = decodeJson(bytes);
    return Value.Check(folderSharePacketSchema, value) ? (value as FolderSharePacket) : undefined;
}

function encodeJson(value: FolderShareDescriptor): Uint8Array {
    return encoder.encode(JSON.stringify(value));
}

function decodeJson(bytes: Uint8Array): unknown {
    try {
        return JSON.parse(decoder.decode(bytes));
    } catch {
        return undefined;
    }
}

function encodeBytes(value: Uint8Array): string {
    return Buffer.from(value).toString("base64url");
}

function decodeIdentity(value: string): Uint8Array {
    const decoded = Buffer.from(value, "base64url");
    if (decoded.length !== 32 || encodeBytes(decoded) !== value) {
        throw new Error("The Murmur identity is invalid.");
    }
    return decoded;
}
