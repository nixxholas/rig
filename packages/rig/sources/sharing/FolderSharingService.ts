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
import type { Context } from "@steve.kite/stdlib";
import { withWorkerContext } from "../observability/daemonContext.js";

import {
    folderShareDescriptorSchema,
    folderSharePacketSchema,
    type FolderShareDescriptor,
    type FolderSharePacket,
    type FolderShareStatus,
    type SharedFolderState,
} from "../protocol/index.js";
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
    query<Result>(ctx: Context, operation: (ctx: Context) => Promise<Result>): Promise<Result>;
    transaction<Result>(
        ctx: Context,
        operation: (ctx: Context) => Promise<Result>,
    ): Promise<Result>;
}

export interface FolderSharingStore {
    applySharedFolderState(
        ctx: Context,
        groupId: string,
        state: SharedFolderState,
    ): Promise<Folder>;
    assertFolderShareable(ctx: Context, folderId: string): Promise<void>;
    getFolder(ctx: Context, folderId: string): Promise<Folder | undefined>;
    markFolderShared(ctx: Context, folderId: string, groupId: string): Promise<Folder>;
    moveFolder(
        ctx: Context,
        folderId: string,
        request: MoveFolderRequest,
        expectedVersion?: number,
    ): Promise<Folder | undefined>;
    sharedFolderGroup(ctx: Context, folderId: string): Promise<string | undefined>;
    sharedFolderState(ctx: Context, rootFolderId: string): Promise<SharedFolderState>;
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
    onChanged: (ctx: Context) => void;
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
    readonly #onChanged: (ctx: Context) => void;
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

    async create(
        ctx: Context,
        rootFolderId: string,
        contacts: readonly string[],
    ): Promise<FolderShareStatus> {
        const client = this.#requireClient();
        await this.recover(ctx);
        const recoveredGroupId = await this.#folders.sharedFolderGroup(ctx, rootFolderId);
        if (recoveredGroupId !== undefined) {
            return await this.#status(
                ctx,
                recoveredGroupId,
                await client.session(decodeIdentity(recoveredGroupId)),
            );
        }
        await this.#folders.assertFolderShareable(ctx, rootFolderId);
        const existingIntent = await this.#database.query(ctx, async (ctx) =>
            queryFolderShareIntentByRoot(ctx, rootFolderId),
        );
        const state =
            existingIntent?.state ?? (await this.#folders.sharedFolderState(ctx, rootFolderId));
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
            await this.#database.transaction(ctx, async (ctx) =>
                folderSharePutIntent(ctx, {
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
        const groupId = await this.#completeCreatedShare(ctx, group, descriptor);
        this.#onChanged(ctx);
        return await this.#status(ctx, groupId, group);
    }

    async onNewSession(session: MurmurServiceSessionDescriptor): Promise<boolean> {
        return await withWorkerContext("folder-sharing-new-session", (ctx) =>
            this.#onNewSession(ctx, session),
        );
    }

    async #onNewSession(ctx: Context, session: MurmurServiceSessionDescriptor): Promise<boolean> {
        const descriptor = decodeDescriptor(session.descriptor);
        if (descriptor === undefined) return false;
        const groupId = encodeBytes(session.id);
        try {
            validateSharedFolderState(descriptor.state);
        } catch {
            return false;
        }
        if (
            (await this.#database.query(ctx, async (ctx) =>
                queryFolderShareByShareId(ctx, descriptor.shareId),
            )) !== undefined
        ) {
            return false;
        }
        this.#applying.add(groupId);
        try {
            await this.#database.transaction(ctx, async (ctx) => {
                await this.#folders.applySharedFolderState(ctx, groupId, descriptor.state);
                await folderShareCreate(ctx, {
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
        this.#onChanged(ctx);
        return true;
    }

    async onUpdate(update: MurmurUpdate): Promise<void> {
        await withWorkerContext("folder-sharing-update", (ctx) => this.#onUpdate(ctx, update));
    }

    async #onUpdate(ctx: Context, update: MurmurUpdate): Promise<void> {
        const packet = decodePacket(update.bytes);
        if (packet === undefined) return;
        const groupId = encodeBytes(update.sessionId);
        const sender = encodeBytes(update.sender);
        if (
            (await this.#database.query(ctx, async (ctx) => queryFolderShare(ctx, groupId))) ===
            undefined
        )
            return;
        const outcome = await this.#database.query(ctx, async (ctx) =>
            folderShareShouldApplyState(ctx, groupId, update.id, packet),
        );
        if (outcome !== "apply") return;
        this.#applying.add(groupId);
        try {
            await this.#database.transaction(ctx, async (ctx) => {
                const state = await folderShareRecordAppliedState(ctx, {
                    deliveryId: update.id,
                    groupId,
                    now: this.#now(),
                    packet,
                    sender,
                });
                await this.#folders.applySharedFolderState(ctx, groupId, state);
            });
        } catch (error) {
            if (isDatabaseFailure(error)) throw error;
            if (
                !(error instanceof FolderShareSemanticError) &&
                !(error instanceof FolderError && error.code !== "storage_unavailable")
            ) {
                throw error;
            }
            await this.#database.transaction(ctx, async (ctx) =>
                folderShareRecordRejectedState(ctx, {
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
        this.#onChanged(ctx);
    }

    /** Reconciles creator-owned Murmur sessions left between durable creation steps. */
    async recover(ctx: Context): Promise<void> {
        const client = this.#requireClient();
        const intents = new Map(
            (await this.#database.query(ctx, async (ctx) => queryFolderShareIntents(ctx))).map(
                (intent) => [intent.shareId, intent],
            ),
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
                await this.#completeCreatedShare(ctx, session, descriptor);
                intents.delete(descriptor.shareId);
            }
            after = page.cursor ?? undefined;
        } while (after !== undefined);
        await this.foldersChanged(ctx);
    }

    /** Observes the already-committed local folder catalog and queues changed share snapshots. */
    async foldersChanged(ctx: Context): Promise<void> {
        await this.#foldersChanged(ctx).catch(this.#onError);
    }

    async #foldersChanged(ctx: Context): Promise<void> {
        const client = this.#client;
        if (client === undefined) return;
        for (const share of await this.#database.query(ctx, async (ctx) =>
            queryFolderShares(ctx),
        )) {
            if (this.#applying.has(share.groupId)) continue;
            const state = await this.#folders.sharedFolderState(ctx, share.rootFolderId);
            validateSharedFolderState(state);
            await this.#database.transaction(ctx, async (ctx) =>
                folderShareQueueState(ctx, {
                    groupId: share.groupId,
                    now: this.#now(),
                    operationId: this.#nextOperationId(),
                    sender: encodeBytes(client.identity),
                    state,
                }),
            );
        }
        this.#scheduleDrain();
    }

    async statuses(ctx: Context): Promise<FolderShareStatus[]> {
        const client = this.#requireClient();
        const results: FolderShareStatus[] = [];
        for (const share of await this.#database.query(ctx, async (ctx) =>
            queryFolderShares(ctx),
        )) {
            results.push(
                await this.#status(
                    ctx,
                    share.groupId,
                    await client.session(decodeIdentity(share.groupId)),
                ),
            );
        }
        return results;
    }

    drain(ctx: Context): Promise<void> {
        this.#drain ??= this.#finishDrain(ctx).finally(() => {
            this.#drain = undefined;
        });
        return this.#drain;
    }

    async #finishDrain(ctx: Context): Promise<void> {
        const client = this.#requireClient();
        while (true) {
            const pending = (
                await this.#database.query(ctx, async (ctx) => queryPendingFolderShareOutbox(ctx))
            )[0];
            if (pending === undefined) return;
            try {
                await client.send(
                    decodeIdentity(pending.groupId),
                    encoder.encode(pending.payloadJson),
                );
                await this.#database.transaction(ctx, async (ctx) =>
                    folderShareOutboxSent(ctx, pending.operationId),
                );
                this.#onChanged(ctx);
            } catch (error) {
                await this.#database.transaction(ctx, async (ctx) =>
                    folderShareOutboxFailed(
                        ctx,
                        pending.operationId,
                        error instanceof Error ? error.message : "Folder synchronization failed.",
                        this.#now(),
                    ),
                );
                this.#onChanged(ctx);
                throw error;
            }
        }
    }

    #scheduleDrain(): void {
        void withWorkerContext("folder-sharing-drain", (ctx) => this.drain(ctx)).catch(
            this.#onError,
        );
    }

    async #status(
        ctx: Context,
        groupId: string,
        session: MurmurSession | undefined,
    ): Promise<FolderShareStatus> {
        const share = await this.#database.query(ctx, async (ctx) =>
            queryFolderShare(ctx, groupId),
        );
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

    async #completeCreatedShare(
        ctx: Context,
        group: MurmurSession,
        descriptor: FolderShareDescriptor,
    ): Promise<string> {
        const groupId = encodeBytes(group.id);
        const client = this.#requireClient();
        await this.#database.transaction(ctx, async (ctx) => {
            const root = await this.#folders.getFolder(ctx, descriptor.state.rootId);
            if (root === undefined) throw new Error("The folder disappeared before it was shared.");
            if (root.parentId !== undefined) {
                await this.#folders.moveFolder(
                    ctx,
                    descriptor.state.rootId,
                    { afterId: null, parentId: null },
                    root.version,
                );
            }
            await this.#folders.markFolderShared(ctx, descriptor.state.rootId, groupId);
            await folderShareCreate(ctx, {
                groupId,
                now: this.#now(),
                rootFolderId: descriptor.state.rootId,
                shareId: descriptor.shareId,
                sender: encodeBytes(client.identity),
                state: descriptor.state,
                status: "syncing",
            });
            await folderShareDeleteIntent(ctx, descriptor.shareId);
        });
        await this.#queueCurrentState(ctx, groupId, descriptor.state.rootId, true);
        return groupId;
    }

    async #queueCurrentState(
        ctx: Context,
        groupId: string,
        rootFolderId: string,
        force: boolean,
    ): Promise<void> {
        const client = this.#requireClient();
        const state = await this.#folders.sharedFolderState(ctx, rootFolderId);
        validateSharedFolderState(state);
        await this.#database.transaction(ctx, async (ctx) =>
            folderShareQueueState(ctx, {
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
