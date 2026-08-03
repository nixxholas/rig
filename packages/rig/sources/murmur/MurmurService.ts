import {
    HttpRelayTransport,
    MurmurClient,
    encodeBase64Url,
    generateIdentityKeyPair,
    hashBytes,
    identityId,
    identityInboxTopic,
    utf8Encode,
    zeroBytes,
    type Contact,
    type IdentityPublicKeys,
    type RelayTransport,
    type ReceivedEvent,
} from "@slopus/murmur";

import type {
    AnswerMurmurFriendRequestRequest,
    AnswerMurmurFriendRequestResponse,
    DeleteMurmurAccountResponse,
    GetMurmurAccountResponse,
    GetMurmurFriendsResponse,
    ListMurmurContactsResponse,
    ListMurmurFriendRequestsResponse,
    MurmurAccount,
    MurmurContact,
    MurmurFriendship,
    MurmurFriendRequest,
    MurmurProfile,
    MurmurServiceState,
    SendMurmurFriendRequestRequest,
    SendMurmurFriendRequestResponse,
    SignupMurmurAccountRequest,
    SignupMurmurAccountResponse,
    StartMurmurServiceRequest,
    StartMurmurServiceResponse,
    StopMurmurServiceResponse,
} from "../protocol/MurmurProtocol.js";
import {
    decodeStoredMurmurAccount,
    destroyStoredMurmurAccount,
    encodeStoredMurmurAccount,
    nativeProfileToPublic,
    publicProfileToNative,
} from "./impl/murmurCodec.js";
import { decodeMurmurIdentityToken, encodeMurmurIdentityToken } from "./impl/identityToken.js";
import { normalizeMurmurPhoto } from "./impl/photoNormalize.js";
import { DatabaseFailureObservingMurmurStore } from "./impl/DatabaseFailureObservingMurmurStore.js";
import { MurmurServiceError } from "./MurmurServiceError.js";
import {
    destroyMurmurFriendship,
    destroyMurmurFriendshipContact,
    MurmurFriendshipManager,
    type MurmurFriendshipChangedEvent,
} from "./MurmurFriendshipManager.js";
import type {
    MurmurEventRouter,
    MurmurLifecycleStore,
    MurmurRuntimeHandle,
    MurmurServiceContract,
    StoredMurmurAccount,
} from "./types.js";
import { isDatabaseFailure } from "../persistence/isDatabaseFailure.js";
import { rethrowDatabaseFailure } from "../persistence/rethrowDatabaseFailure.js";

const ACCOUNT_KEY = "rig/murmur/account/v1";
const DEFAULT_SYNC_WAIT_MILLISECONDS = 25_000;
const DEFAULT_SYNC_RETRY_DELAY_MILLISECONDS = 1_000;
const DEFAULT_RELAY_REQUEST_TIMEOUT_MILLISECONDS = 30_000;
export const DEFAULT_MURMUR_RELAY_URLS = ["https://murmur.cluster-fluster.com/"] as const;

interface MurmurRuntime {
    readonly account: StoredMurmurAccount;
    readonly client: MurmurClient;
    readonly controller: AbortController;
    readonly observedStore: DatabaseFailureObservingMurmurStore;
    readonly transports: readonly RelayTransport[];
    relayFlush: Promise<void> | undefined;
    loop: Promise<void>;
}

interface PendingStoreDeletion {
    readonly existed: boolean;
    readonly store: MurmurLifecycleStore;
}

export interface MurmurServiceOptions {
    readonly defaultRelayUrls?: readonly string[];
    readonly maxRelationships?: number;
    readonly now?: () => number;
    readonly publishGlobalEvent?: (event: MurmurFriendshipChangedEvent) => void | Promise<void>;
    readonly relayRequestTimeoutMilliseconds?: number;
    readonly storeFactory: () => MurmurLifecycleStore | Promise<MurmurLifecycleStore>;
    readonly syncRetryDelayMilliseconds?: number;
    readonly syncWaitMilliseconds?: number;
    readonly transportFactory?: (relayUrls: readonly string[]) => readonly RelayTransport[];
}

function destroyPublicIdentity(identity: IdentityPublicKeys): void {
    zeroBytes(identity.signingKey);
    zeroBytes(identity.encryptionKey);
}

function contactToPublic(contact: Contact): MurmurContact {
    return {
        addedAt: contact.addedAt,
        id: identityId(contact.identity),
        profile: nativeProfileToPublic(contact.profile),
        token: encodeMurmurIdentityToken(contact.identity),
        updatedAt: contact.updatedAt,
    };
}

function destroyContact(contact: Contact): void {
    destroyPublicIdentity(contact.identity);
    if (contact.profile.avatar !== undefined) zeroBytes(contact.profile.avatar);
}

function accountToPublic(account: StoredMurmurAccount): MurmurAccount {
    return {
        id: identityId(account.identity),
        profile: nativeProfileToPublic(account.profile),
        token: encodeMurmurIdentityToken(account.identity),
    };
}

function friendshipToPublic(
    friendship: import("./MurmurFriendshipManager.js").MurmurFriendship,
): MurmurFriendship {
    return {
        ...(friendship.answeredAt === undefined ? {} : { answeredAt: friendship.answeredAt }),
        autoAcceptEligible: friendship.autoAcceptEligible,
        direction: friendship.direction,
        firstSeenAt: friendship.firstSeenAt,
        history: friendship.history,
        peerId: identityId(friendship.identity),
        ...(friendship.profile === undefined
            ? {}
            : { profile: nativeProfileToPublic(friendship.profile) }),
        ...(friendship.requestId === undefined ? {} : { requestId: friendship.requestId }),
        state: friendship.state,
        token: encodeMurmurIdentityToken(friendship.identity),
        updatedAt: friendship.updatedAt,
        version: friendship.eventVersion,
    };
}

function pendingFriendshipToPublic(
    friendship: import("./MurmurFriendshipManager.js").MurmurFriendship,
): MurmurFriendRequest {
    if (friendship.profile === undefined) {
        throw new Error("A pending Murmur friend request has no profile");
    }
    return {
        id: identityId(friendship.identity),
        profile: nativeProfileToPublic(friendship.profile),
        receivedAt: friendship.updatedAt,
        senderId: identityId(friendship.identity),
        senderToken: encodeMurmurIdentityToken(friendship.identity),
    };
}

function validateRelayUrls(relayUrls: readonly string[]): readonly string[] {
    if (relayUrls.length === 0 || new Set(relayUrls).size !== relayUrls.length) {
        throw new Error("Murmur requires at least one unique relay URL");
    }
    return relayUrls.map((relayUrl) => {
        const parsed = new URL(relayUrl);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
            throw new Error("Murmur relay URLs must use HTTP or HTTPS");
        }
        return relayUrl;
    });
}

function createHttpTransports(
    relayUrls: readonly string[],
    requestTimeoutMilliseconds: number,
): readonly RelayTransport[] {
    const fetchWithTimeout: typeof globalThis.fetch = (input, init = {}) => {
        const timeoutSignal = AbortSignal.timeout(requestTimeoutMilliseconds);
        const signal =
            init.signal == null ? timeoutSignal : AbortSignal.any([init.signal, timeoutSignal]);
        return globalThis.fetch(input, { ...init, signal });
    };
    return relayUrls.map((relayUrl) => {
        const bytes = utf8Encode(relayUrl);
        const digest = hashBytes(bytes);
        try {
            return new HttpRelayTransport(
                `relay-${encodeBase64Url(digest).slice(0, 16)}`,
                relayUrl,
                fetchWithTimeout,
            );
        } finally {
            zeroBytes(bytes);
            zeroBytes(digest);
        }
    });
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
        if (signal.aborted) {
            resolve();
            return;
        }
        const finish = () => {
            signal.removeEventListener("abort", onAbort);
            resolve();
        };
        const timer = setTimeout(finish, milliseconds);
        timer.unref?.();
        const onAbort = () => {
            clearTimeout(timer);
            finish();
        };
        signal.addEventListener("abort", onAbort, { once: true });
    });
}

/**
 * Durable account, friend-request, and contact lifecycle over `@slopus/murmur`.
 *
 * Every public operation is sequenced. The background sync loop performs only
 * MurmurStore transactions, so request persistence and relay cursor progress
 * remain one atomic boundary.
 */
export class MurmurService implements MurmurServiceContract {
    readonly #defaultRelayUrls: readonly string[];
    readonly #maxRelationships: number | undefined;
    readonly #now: (() => number) | undefined;
    readonly #publishGlobalEvent: MurmurServiceOptions["publishGlobalEvent"];
    readonly #storeFactory: MurmurServiceOptions["storeFactory"];
    readonly #syncRetryDelayMilliseconds: number;
    readonly #syncWaitMilliseconds: number;
    readonly #transportFactory: NonNullable<MurmurServiceOptions["transportFactory"]>;
    #closed = false;
    #friendships: MurmurFriendshipManager | undefined;
    #relayUrls: readonly string[] = [];
    #runtime: MurmurRuntime | undefined;
    #sequence: Promise<void> = Promise.resolve();
    #store: MurmurLifecycleStore | undefined;
    readonly #eventRouters = new Set<MurmurEventRouter>();
    readonly #runtimeListeners = new Set<(runtime: MurmurRuntimeHandle | undefined) => void>();
    #storeDeletion: PendingStoreDeletion | undefined;
    readonly #ready: Promise<void>;

    constructor(options: MurmurServiceOptions) {
        this.#defaultRelayUrls = validateRelayUrls(
            options.defaultRelayUrls ?? DEFAULT_MURMUR_RELAY_URLS,
        );
        this.#storeFactory = options.storeFactory;
        this.#maxRelationships = options.maxRelationships;
        this.#now = options.now;
        this.#publishGlobalEvent = options.publishGlobalEvent;
        const relayRequestTimeoutMilliseconds =
            options.relayRequestTimeoutMilliseconds ?? DEFAULT_RELAY_REQUEST_TIMEOUT_MILLISECONDS;
        if (
            !Number.isSafeInteger(relayRequestTimeoutMilliseconds) ||
            relayRequestTimeoutMilliseconds < 1
        ) {
            throw new Error("Murmur relay request timeout must be a positive integer");
        }
        this.#syncRetryDelayMilliseconds =
            options.syncRetryDelayMilliseconds ?? DEFAULT_SYNC_RETRY_DELAY_MILLISECONDS;
        if (
            !Number.isSafeInteger(this.#syncRetryDelayMilliseconds) ||
            this.#syncRetryDelayMilliseconds < 0
        ) {
            throw new Error("Murmur synchronization retry delay must be a non-negative integer");
        }
        this.#syncWaitMilliseconds = options.syncWaitMilliseconds ?? DEFAULT_SYNC_WAIT_MILLISECONDS;
        this.#transportFactory =
            options.transportFactory ??
            ((relayUrls) => createHttpTransports(relayUrls, relayRequestTimeoutMilliseconds));
        this.#ready = Promise.resolve(options.storeFactory()).then((store) => {
            this.#installStore(store);
        });
    }

    async getAccount(): Promise<GetMurmurAccountResponse> {
        return this.#serialize(async () => {
            await this.#requireFriendships().drainGlobalEventOutbox();
            return {
                ...(await this.#loadPublicAccount()),
                service: this.#serviceState(),
            };
        });
    }

    async signup(request: SignupMurmurAccountRequest): Promise<SignupMurmurAccountResponse> {
        return this.#serialize(async () => {
            const store = this.#requireStore();
            const existing = await store.get(ACCOUNT_KEY);
            if (existing !== undefined) {
                zeroBytes(existing);
                throw new MurmurServiceError("account_exists", "A Murmur account already exists");
            }
            let photo;
            try {
                photo =
                    request.photo === undefined
                        ? undefined
                        : await normalizeMurmurPhoto(request.photo);
            } catch (error: unknown) {
                throw new MurmurServiceError("invalid_profile", "The Murmur profile is invalid", {
                    cause: error,
                });
            }
            const profile: MurmurProfile = {
                firstName: request.firstName,
                lastName: request.lastName,
                ...(photo === undefined ? {} : { photo }),
            };
            let nativeProfile;
            try {
                nativeProfile = publicProfileToNative(profile);
            } catch (error: unknown) {
                throw new MurmurServiceError("invalid_profile", "The Murmur profile is invalid", {
                    cause: error,
                });
            }
            const account: StoredMurmurAccount = {
                identity: generateIdentityKeyPair(),
                profile: nativeProfile,
            };
            let encoded: Uint8Array | undefined;
            try {
                encoded = encodeStoredMurmurAccount(account);
                await store.transaction(async (transaction) => {
                    const transactionExisting = await transaction.get(ACCOUNT_KEY);
                    if (transactionExisting !== undefined) {
                        zeroBytes(transactionExisting);
                        throw new MurmurServiceError(
                            "account_exists",
                            "A Murmur account already exists",
                        );
                    }
                    await transaction.set(ACCOUNT_KEY, encoded!.slice());
                });
                return { account: accountToPublic(account), service: this.#serviceState() };
            } finally {
                if (encoded !== undefined) zeroBytes(encoded);
                destroyStoredMurmurAccount(account);
            }
        });
    }

    async start(request: StartMurmurServiceRequest = {}): Promise<StartMurmurServiceResponse> {
        return this.#serialize(async () => {
            const relayUrls = validateRelayUrls(request.relayUrls ?? this.#defaultRelayUrls);
            if (
                this.#runtime !== undefined &&
                relayUrls.length === this.#relayUrls.length &&
                relayUrls.every((url, index) => url === this.#relayUrls[index])
            ) {
                return { service: this.#serviceState() };
            }
            await this.#stopRuntime();
            const account = await this.#readAccount();
            if (account === undefined) {
                throw new MurmurServiceError("account_missing", "No Murmur account exists");
            }
            try {
                const transports = this.#transportFactory(relayUrls);
                const observedStore = new DatabaseFailureObservingMurmurStore(this.#requireStore());
                const client = new MurmurClient({
                    identity: account.identity,
                    store: observedStore,
                    transports,
                });
                await client.subscribe(identityInboxTopic(account.identity));
                const runtime: MurmurRuntime = {
                    account,
                    client,
                    controller: new AbortController(),
                    loop: Promise.resolve(),
                    observedStore,
                    relayFlush: undefined,
                    transports,
                };
                this.#relayUrls = relayUrls;
                this.#runtime = runtime;
                runtime.loop = this.#syncLoop(runtime);
                void runtime.loop.catch(rethrowDatabaseFailure);
                void this.#flushRelayOutbox(runtime).catch(rethrowDatabaseFailure);
                this.#announceRuntime();
                return { service: this.#serviceState() };
            } catch (error: unknown) {
                destroyStoredMurmurAccount(account);
                throw error;
            }
        });
    }

    async stop(): Promise<StopMurmurServiceResponse> {
        return this.#serialize(async () => {
            await this.#stopRuntime();
            return { service: this.#serviceState() };
        });
    }

    async deleteAccount(): Promise<DeleteMurmurAccountResponse> {
        return this.#serialize(async () => {
            await this.#stopRuntime();
            let deletion = this.#storeDeletion;
            if (deletion === undefined) {
                const store = this.#requireStore();
                const encoded = await store.get(ACCOUNT_KEY);
                const existed = encoded !== undefined;
                if (encoded !== undefined) zeroBytes(encoded);
                await store.close();
                this.#store = undefined;
                deletion = { existed, store };
                this.#storeDeletion = deletion;
            }
            await deletion.store.deleteDatabaseFiles();
            const replacement = await this.#storeFactory();
            this.#installStore(replacement);
            this.#storeDeletion = undefined;
            return { deleted: deletion.existed };
        });
    }

    async sendFriendRequest(
        request: SendMurmurFriendRequestRequest,
    ): Promise<SendMurmurFriendRequestResponse> {
        return this.#serialize(async () => {
            let recipient: IdentityPublicKeys;
            try {
                recipient = decodeMurmurIdentityToken(request.token);
            } catch (error: unknown) {
                throw new MurmurServiceError(
                    "invalid_identity_token",
                    "The Murmur identity token is invalid",
                    { cause: error },
                );
            }
            const runtime = this.#runtime;
            const account = runtime?.account ?? (await this.#readAccount());
            if (account === undefined) {
                destroyPublicIdentity(recipient);
                throw new MurmurServiceError("account_missing", "No Murmur account exists");
            }
            const destroyAccount = runtime === undefined;
            try {
                if (identityId(recipient) === identityId(account.identity)) {
                    throw new MurmurServiceError(
                        "invalid_identity_token",
                        "A Murmur account cannot send a friend request to itself",
                    );
                }
                const result = await this.#requireFriendships().queueFriendRequest(
                    account.identity,
                    account.profile,
                    recipient,
                );
                const recipientId = identityId(recipient);
                try {
                    if (runtime !== undefined) {
                        void this.#flushRelayOutbox(runtime).catch(rethrowDatabaseFailure);
                    }
                    return {
                        friendship: friendshipToPublic(result.friendship),
                        queued: result.queued,
                        recipientId,
                        stats: await this.#requireFriendships().stats(),
                    };
                } finally {
                    destroyMurmurFriendship(result.friendship);
                }
            } finally {
                if (destroyAccount) destroyStoredMurmurAccount(account);
                destroyPublicIdentity(recipient);
            }
        });
    }

    async listFriendRequests(): Promise<ListMurmurFriendRequestsResponse> {
        return this.#serialize(async () => {
            await this.#requireAccountExists();
            const pending = await this.#requireFriendships().listPendingIncoming();
            const requests: MurmurFriendRequest[] = [];
            for (const friendship of pending) {
                try {
                    requests.push(pendingFriendshipToPublic(friendship));
                } finally {
                    destroyMurmurFriendship(friendship);
                }
            }
            return { requests };
        });
    }

    async getFriends(): Promise<GetMurmurFriendsResponse> {
        return this.#serialize(async () => {
            await this.#requireFriendships().drainGlobalEventOutbox();
            const account = await this.#readAccount();
            if (account === undefined) {
                return {
                    contacts: [],
                    friendships: [],
                    service: this.#serviceState(),
                    stats: await this.#requireFriendships().stats(),
                };
            }
            const friendships = await this.#requireFriendships().listFriendships();
            const contacts = await this.#requireFriendships().listContacts(account.identity);
            try {
                return {
                    account: accountToPublic(account),
                    contacts: contacts.map(contactToPublic),
                    friendships: friendships.map(friendshipToPublic),
                    service: this.#serviceState(),
                    stats: await this.#requireFriendships().stats(),
                };
            } finally {
                for (const friendship of friendships) destroyMurmurFriendship(friendship);
                for (const contact of contacts) destroyMurmurFriendshipContact(contact);
                destroyStoredMurmurAccount(account);
            }
        });
    }

    async answerFriendRequest(
        peerId: string,
        request: AnswerMurmurFriendRequestRequest,
    ): Promise<AnswerMurmurFriendRequestResponse> {
        return this.#serialize(async () => {
            const runtime = this.#runtime;
            const account = runtime?.account ?? (await this.#readAccount());
            if (account === undefined) {
                throw new MurmurServiceError("account_missing", "No Murmur account exists");
            }
            const destroyAccount = runtime === undefined;
            let result;
            try {
                result = await this.#requireFriendships().answerIncoming(
                    account.identity,
                    account.profile,
                    peerId,
                    request.answer,
                );
            } catch (error: unknown) {
                if (error instanceof Error && error.message === "Murmur friend request not found") {
                    throw new MurmurServiceError(
                        "request_not_found",
                        "Murmur friend request not found",
                        { cause: error },
                    );
                }
                throw error;
            } finally {
                if (destroyAccount) destroyStoredMurmurAccount(account);
            }
            try {
                if (runtime !== undefined) {
                    void this.#flushRelayOutbox(runtime).catch(rethrowDatabaseFailure);
                }
                return {
                    answer: result.answer,
                    ...(result.contact === undefined
                        ? {}
                        : { contact: contactToPublic(result.contact) }),
                    friendship: friendshipToPublic(result.friendship),
                    stats: await this.#requireFriendships().stats(),
                };
            } finally {
                if (result.contact !== undefined) {
                    destroyMurmurFriendshipContact(result.contact);
                }
                destroyMurmurFriendship(result.friendship);
            }
        });
    }

    async listContacts(): Promise<ListMurmurContactsResponse> {
        return this.#serialize(async () => {
            const account = await this.#readAccount();
            if (account === undefined) {
                throw new MurmurServiceError("account_missing", "No Murmur account exists");
            }
            try {
                const contacts = await this.#requireFriendships().listContacts(account.identity);
                return {
                    contacts: contacts.map((contact) => {
                        try {
                            return contactToPublic(contact);
                        } finally {
                            destroyContact(contact);
                        }
                    }),
                };
            } finally {
                destroyStoredMurmurAccount(account);
            }
        });
    }

    runtime(): MurmurRuntimeHandle | undefined {
        const runtime = this.#runtime;
        if (runtime === undefined) return undefined;
        return {
            client: runtime.client,
            identity: runtime.account.identity,
            store: runtime.observedStore,
        };
    }

    onRuntimeChanged(listener: (runtime: MurmurRuntimeHandle | undefined) => void): () => void {
        this.#runtimeListeners.add(listener);
        return () => {
            this.#runtimeListeners.delete(listener);
        };
    }

    registerEventRouter(router: MurmurEventRouter): () => void {
        this.#eventRouters.add(router);
        return () => {
            this.#eventRouters.delete(router);
        };
    }

    async close(): Promise<void> {
        return this.#serialize(async () => {
            if (this.#closed) return;
            await this.#stopRuntime();
            if (this.#store !== undefined) await this.#store.close();
            this.#store = undefined;
            this.#friendships = undefined;
            this.#closed = true;
        }, true);
    }

    async #serialize<Result>(
        operation: () => Promise<Result>,
        allowClosed: boolean = false,
    ): Promise<Result> {
        const execute = async () => {
            await this.#ready;
            if (this.#closed && !allowClosed) throw new Error("Murmur service is closed");
            return operation();
        };
        const result = this.#sequence.then(execute, execute);
        this.#sequence = result.then(
            () => undefined,
            () => undefined,
        );
        return result;
    }

    #requireStore(): MurmurLifecycleStore {
        if (this.#store === undefined) throw new Error("Murmur store is unavailable");
        return this.#store;
    }

    #installStore(store: MurmurLifecycleStore): void {
        this.#store = store;
        this.#friendships = new MurmurFriendshipManager({
            ...(this.#maxRelationships === undefined
                ? {}
                : { maxRelationships: this.#maxRelationships }),
            ...(this.#now === undefined ? {} : { now: this.#now }),
            ...(this.#publishGlobalEvent === undefined
                ? {}
                : { publishGlobalEvent: this.#publishGlobalEvent }),
            store,
        });
    }

    #requireFriendships(): MurmurFriendshipManager {
        if (this.#friendships === undefined) {
            throw new Error("Murmur friendship store is unavailable");
        }
        return this.#friendships;
    }

    #serviceState(): MurmurServiceState {
        return {
            relayUrls: [...this.#relayUrls],
            status: this.#runtime === undefined ? "stopped" : "running",
        };
    }

    async #readAccount(): Promise<StoredMurmurAccount | undefined> {
        const encoded = await this.#requireStore().get(ACCOUNT_KEY);
        if (encoded === undefined) return undefined;
        try {
            return decodeStoredMurmurAccount(encoded);
        } finally {
            zeroBytes(encoded);
        }
    }

    async #loadPublicAccount(): Promise<Pick<GetMurmurAccountResponse, "account">> {
        const account = await this.#readAccount();
        if (account === undefined) return {};
        try {
            return { account: accountToPublic(account) };
        } finally {
            destroyStoredMurmurAccount(account);
        }
    }

    async #requireAccountExists(): Promise<void> {
        const encoded = await this.#requireStore().get(ACCOUNT_KEY);
        if (encoded === undefined) {
            throw new MurmurServiceError("account_missing", "No Murmur account exists");
        }
        zeroBytes(encoded);
    }

    async #stopRuntime(): Promise<void> {
        const runtime = this.#runtime;
        if (runtime === undefined) {
            this.#relayUrls = [];
            return;
        }
        runtime.controller.abort();
        try {
            await runtime.loop;
            if (runtime.relayFlush !== undefined) await runtime.relayFlush;
        } finally {
            if (this.#runtime === runtime) this.#runtime = undefined;
            this.#relayUrls = [];
            this.#announceRuntime();
            destroyStoredMurmurAccount(runtime.account);
        }
    }

    async #syncLoop(runtime: MurmurRuntime): Promise<void> {
        const signal = runtime.controller.signal;
        while (!signal.aborted) {
            try {
                await this.#flushRelayOutbox(runtime);
                const result = await runtime.client.sync(this.#syncWaitMilliseconds, signal);
                if (signal.aborted) break;
                if (result.status === "reset") {
                    for (const reset of result.resets) {
                        await runtime.client.loadTopic(
                            reset.topic,
                            async (transaction, state) => {
                                for (const element of state.elements) {
                                    const processed =
                                        await this.#requireFriendships().processInboundPayload(
                                            runtime.account.identity,
                                            runtime.account.profile,
                                            transaction,
                                            element.bytes,
                                            Date.now(),
                                        );
                                    if (processed.friendship !== undefined) {
                                        destroyMurmurFriendship(processed.friendship);
                                    }
                                }
                            },
                            reset.relayId,
                        );
                    }
                    await this.#requireFriendships().drainGlobalEventOutbox();
                    await this.#flushRelayOutbox(runtime);
                } else {
                    for (const received of result.events) {
                        await this.#persistReceivedEvent(runtime, received);
                    }
                    if (result.events.length === 0) await abortableDelay(50, signal);
                }
            } catch (error: unknown) {
                const databaseFailure = runtime.observedStore.takeDatabaseFailure();
                if (databaseFailure !== undefined) throw databaseFailure;
                if (isDatabaseFailure(error)) throw error;
                if (signal.aborted) break;
                await abortableDelay(this.#syncRetryDelayMilliseconds, signal);
            }
        }
    }

    #announceRuntime(): void {
        const handle = this.runtime();
        for (const listener of this.#runtimeListeners) listener(handle);
    }

    async #routeReceivedEvent(received: ReceivedEvent): Promise<boolean> {
        for (const router of this.#eventRouters) {
            if (await router(received)) return true;
        }
        return false;
    }

    async #persistReceivedEvent(runtime: MurmurRuntime, received: ReceivedEvent): Promise<void> {
        if (await this.#routeReceivedEvent(received)) return;
        const inbox = identityInboxTopic(runtime.account.identity);
        if (received.event.topic !== inbox) {
            await this.#requireStore().transaction(async (transaction) => {
                await received.advanceCursor(transaction);
            });
            return;
        }
        await this.#requireStore().transaction(async (transaction) => {
            const processed = await this.#requireFriendships().processInboundPayload(
                runtime.account.identity,
                runtime.account.profile,
                transaction,
                received.event.payload,
                received.event.createdAt,
            );
            if (processed.friendship !== undefined) {
                destroyMurmurFriendship(processed.friendship);
            }
            await received.advanceCursor(transaction);
        });
        await this.#requireFriendships().drainGlobalEventOutbox();
        await this.#flushRelayOutbox(runtime);
    }

    #flushRelayOutbox(runtime: MurmurRuntime): Promise<void> {
        if (runtime.relayFlush !== undefined) return runtime.relayFlush;
        const task = this.#requireFriendships()
            .flushRelayOutbox(runtime.transports)
            .then(() => undefined);
        runtime.relayFlush = task;
        const clear = () => {
            if (runtime.relayFlush === task) runtime.relayFlush = undefined;
        };
        void task.then(clear, clear);
        return task;
    }
}
