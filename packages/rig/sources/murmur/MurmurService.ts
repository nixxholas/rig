import {
    ContactBook,
    HttpRelayTransport,
    MurmurClient,
    createRelayEvent,
    decryptContactProfile,
    destroyIdentity,
    encodeBase64Url,
    encryptProfileForContact,
    generateIdentityKeyPair,
    hashBytes,
    identityId,
    identityInboxTopic,
    utf8Encode,
    zeroBytes,
    type Contact,
    type IdentityPublicKeys,
    type ReceivedEvent,
    type RelayTransport,
    type SignedRelayEvent,
    type StoreTransaction,
} from "@slopus/murmur";

import type {
    AnswerMurmurFriendRequestRequest,
    AnswerMurmurFriendRequestResponse,
    DeleteMurmurAccountResponse,
    GetMurmurAccountResponse,
    ListMurmurContactsResponse,
    ListMurmurFriendRequestsResponse,
    MurmurAccount,
    MurmurContact,
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
    decodeFriendRequestEnvelope,
    decodeStoredHandledRequest,
    decodeStoredMurmurAccount,
    decodeStoredOutboundEvent,
    decodeStoredPendingRequest,
    decodeStoredPendingRequestCount,
    destroyStoredMurmurAccount,
    encodeFriendRequestEnvelope,
    encodeHandledRequestEnvelope,
    encodeStoredHandledRequest,
    encodeStoredMurmurAccount,
    encodeStoredOutboundEvent,
    encodeStoredPendingRequest,
    encodeStoredPendingRequestCount,
    nativeProfileToPublic,
    openedProfileToPending,
    pendingToOpened,
    publicProfileToNative,
    isHandledRequestEnvelope,
    type StoredPendingRequest,
} from "./impl/murmurCodec.js";
import { decodeMurmurIdentityToken, encodeMurmurIdentityToken } from "./impl/identityToken.js";
import { normalizeMurmurPhoto } from "./impl/photoNormalize.js";
import { DatabaseFailureObservingMurmurStore } from "./impl/DatabaseFailureObservingMurmurStore.js";
import { MurmurServiceError } from "./MurmurServiceError.js";
import type { MurmurLifecycleStore, MurmurServiceContract, StoredMurmurAccount } from "./types.js";
import { isDatabaseFailure } from "../persistence/isDatabaseFailure.js";
import { rethrowDatabaseFailure } from "../persistence/rethrowDatabaseFailure.js";

const ACCOUNT_KEY = "rig/murmur/account/v1";
const PENDING_PREFIX = "rig/murmur/friend-requests/pending/v1/";
const PENDING_COUNT_KEY = "rig/murmur/friend-requests/pending-count/v1";
const HANDLED_PREFIX = "rig/murmur/friend-requests/handled/v1/";
const OUTBOUND_FRIEND_PREFIX = "rig/murmur/outbound/friend-request/v1/";
const OUTBOUND_ANSWER_PREFIX = "rig/murmur/outbound/friend-answer/v1/";
const QUARANTINE_PREFIX = "rig/murmur/quarantine/v1/";
const MAX_QUARANTINE_RECORDS = 100;
const MAX_HANDLED_REQUESTS = 10_000;
const MAX_OUTBOUND_FRIEND_REQUESTS = 256;
const DEFAULT_MAX_PENDING_REQUESTS = 1_000;
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
    loop: Promise<void>;
}

interface PendingStoreDeletion {
    readonly existed: boolean;
    readonly store: MurmurLifecycleStore;
}

export interface MurmurServiceOptions {
    readonly defaultRelayUrls?: readonly string[];
    readonly maxPendingFriendRequests?: number;
    readonly relayRequestTimeoutMilliseconds?: number;
    readonly storeFactory: () => MurmurLifecycleStore | Promise<MurmurLifecycleStore>;
    readonly syncRetryDelayMilliseconds?: number;
    readonly syncWaitMilliseconds?: number;
    readonly transportFactory?: (relayUrls: readonly string[]) => readonly RelayTransport[];
}

function pendingKey(id: string): string {
    return `${PENDING_PREFIX}${id}`;
}

function handledKey(id: string): string {
    return `${HANDLED_PREFIX}${id}`;
}

function outboundFriendKey(recipientId: string): string {
    return `${OUTBOUND_FRIEND_PREFIX}${recipientId}`;
}

function outboundAnswerKey(id: string): string {
    return `${OUTBOUND_ANSWER_PREFIX}${id}`;
}

function payloadId(payload: Uint8Array): string {
    const digest = hashBytes(payload);
    try {
        return encodeBase64Url(digest);
    } finally {
        zeroBytes(digest);
    }
}

function destroyPublicIdentity(identity: IdentityPublicKeys): void {
    zeroBytes(identity.signingKey);
    zeroBytes(identity.encryptionKey);
}

function destroySignedRelayEvent(event: SignedRelayEvent): void {
    zeroBytes(event.author.signingKey);
    zeroBytes(event.payload);
    zeroBytes(event.signature);
    if (event.snapshot?.bytes !== undefined) zeroBytes(event.snapshot.bytes);
    for (const operation of event.list ?? []) {
        if ("bytes" in operation) zeroBytes(operation.bytes);
    }
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

function pendingToPublic(request: StoredPendingRequest): MurmurFriendRequest {
    const opened = pendingToOpened(request);
    try {
        return {
            id: request.id,
            profile: nativeProfileToPublic(opened.profile),
            receivedAt: request.receivedAt,
            senderId: identityId(opened.identity),
            senderToken: encodeMurmurIdentityToken(opened.identity),
        };
    } finally {
        destroyPublicIdentity(opened.identity);
        if (opened.profile.avatar !== undefined) zeroBytes(opened.profile.avatar);
    }
}

function accountToPublic(account: StoredMurmurAccount): MurmurAccount {
    return {
        id: identityId(account.identity),
        profile: nativeProfileToPublic(account.profile),
        token: encodeMurmurIdentityToken(account.identity),
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
    readonly #maxPendingFriendRequests: number;
    readonly #storeFactory: MurmurServiceOptions["storeFactory"];
    readonly #syncRetryDelayMilliseconds: number;
    readonly #syncWaitMilliseconds: number;
    readonly #transportFactory: NonNullable<MurmurServiceOptions["transportFactory"]>;
    #closed = false;
    #relayUrls: readonly string[] = [];
    #runtime: MurmurRuntime | undefined;
    #sequence: Promise<void> = Promise.resolve();
    #store: MurmurLifecycleStore | undefined;
    #storeDeletion: PendingStoreDeletion | undefined;
    readonly #ready: Promise<void>;

    constructor(options: MurmurServiceOptions) {
        this.#defaultRelayUrls = validateRelayUrls(
            options.defaultRelayUrls ?? DEFAULT_MURMUR_RELAY_URLS,
        );
        this.#storeFactory = options.storeFactory;
        this.#maxPendingFriendRequests =
            options.maxPendingFriendRequests ?? DEFAULT_MAX_PENDING_REQUESTS;
        if (
            !Number.isSafeInteger(this.#maxPendingFriendRequests) ||
            this.#maxPendingFriendRequests < 1 ||
            this.#maxPendingFriendRequests > DEFAULT_MAX_PENDING_REQUESTS
        ) {
            throw new Error("Murmur pending friend-request limit must be between 1 and 1,000");
        }
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
            this.#store = store;
        });
    }

    async getAccount(): Promise<GetMurmurAccountResponse> {
        return this.#serialize(async () => ({
            ...(await this.#loadPublicAccount()),
            service: this.#serviceState(),
        }));
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
                    transports,
                };
                this.#relayUrls = relayUrls;
                this.#runtime = runtime;
                runtime.loop = this.#syncLoop(runtime);
                void runtime.loop.catch(rethrowDatabaseFailure);
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
            this.#store = replacement;
            this.#storeDeletion = undefined;
            return { deleted: deletion.existed };
        });
    }

    async sendFriendRequest(
        request: SendMurmurFriendRequestRequest,
    ): Promise<SendMurmurFriendRequestResponse> {
        return this.#serialize(async () => {
            const runtime = this.#requireRuntime();
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
            let payload: Uint8Array | undefined;
            try {
                if (identityId(recipient) === identityId(runtime.account.identity)) {
                    throw new MurmurServiceError(
                        "invalid_identity_token",
                        "A Murmur account cannot send a friend request to itself",
                    );
                }
                payload = encodeFriendRequestEnvelope(
                    encryptProfileForContact(
                        runtime.account.identity,
                        recipient,
                        runtime.account.profile,
                    ),
                );
                const id = payloadId(payload);
                const recipientId = identityId(recipient);
                const complete = await this.#publishPreparedOutbound(
                    runtime,
                    outboundFriendKey(recipientId),
                    OUTBOUND_FRIEND_PREFIX,
                    MAX_OUTBOUND_FRIEND_REQUESTS,
                    () => {
                        const ephemeralAuthor = generateIdentityKeyPair();
                        try {
                            return createRelayEvent(
                                ephemeralAuthor,
                                identityInboxTopic(recipient),
                                payload!,
                                {
                                    list: [
                                        {
                                            bytes: payload!,
                                            id: `profile:${id}`,
                                            op: "append",
                                        },
                                    ],
                                },
                            );
                        } finally {
                            destroyIdentity(ephemeralAuthor);
                        }
                    },
                );
                if (!complete) {
                    throw new MurmurServiceError(
                        "relay_unavailable",
                        "Every Murmur relay must confirm the friend request",
                    );
                }
                await this.#requireStore().delete(outboundFriendKey(recipientId));
                return { recipientId };
            } finally {
                if (payload !== undefined) zeroBytes(payload);
                destroyPublicIdentity(recipient);
            }
        });
    }

    async listFriendRequests(): Promise<ListMurmurFriendRequestsResponse> {
        return this.#serialize(async () => {
            await this.#requireAccountExists();
            const values = await this.#requireStore().list(PENDING_PREFIX);
            const requests: MurmurFriendRequest[] = [];
            for (const value of values.values()) {
                try {
                    requests.push(pendingToPublic(decodeStoredPendingRequest(value)));
                } finally {
                    zeroBytes(value);
                }
            }
            requests.sort(
                (left, right) =>
                    left.receivedAt - right.receivedAt || left.id.localeCompare(right.id),
            );
            return { requests };
        });
    }

    async answerFriendRequest(
        id: string,
        request: AnswerMurmurFriendRequestRequest,
    ): Promise<AnswerMurmurFriendRequestResponse> {
        return this.#serialize(async () => {
            const runtime = this.#requireRuntime();
            const store = this.#requireStore();
            const encodedPending = await store.get(pendingKey(id));
            if (encodedPending === undefined) {
                throw new MurmurServiceError(
                    "request_not_found",
                    "Murmur friend request not found",
                );
            }
            zeroBytes(encodedPending);
            const cleanupPayload = encodeHandledRequestEnvelope(id);
            try {
                const outboxKey = outboundAnswerKey(id);
                const complete = await this.#publishPreparedOutbound(
                    runtime,
                    outboxKey,
                    OUTBOUND_ANSWER_PREFIX,
                    DEFAULT_MAX_PENDING_REQUESTS,
                    () =>
                        createRelayEvent(
                            runtime.account.identity,
                            identityInboxTopic(runtime.account.identity),
                            cleanupPayload,
                            { list: [{ id: `profile:${id}`, op: "delete" }] },
                        ),
                );
                if (!complete) {
                    throw new MurmurServiceError(
                        "relay_unavailable",
                        "Every Murmur relay must confirm the friend-request answer",
                    );
                }
                const contacts = new ContactBook(runtime.account.identity, store);
                return await store.transaction(async (transaction) => {
                    const encoded = await transaction.get(pendingKey(id));
                    if (encoded === undefined) {
                        throw new MurmurServiceError(
                            "request_not_found",
                            "Murmur friend request not found",
                        );
                    }
                    try {
                        const pending = decodeStoredPendingRequest(encoded);
                        await this.#recordHandledRequest(
                            transaction,
                            id,
                            request.answer,
                            Date.now(),
                        );
                        if (request.answer === "reject") {
                            await transaction.delete(pendingKey(id));
                            await transaction.delete(outboxKey);
                            await this.#decrementPendingCount(transaction);
                            return { answer: "reject" };
                        }
                        const opened = pendingToOpened(pending);
                        try {
                            const contact = await contacts.saveInTransaction(transaction, opened);
                            try {
                                await transaction.delete(pendingKey(id));
                                await transaction.delete(outboxKey);
                                await this.#decrementPendingCount(transaction);
                                return { answer: "accept", contact: contactToPublic(contact) };
                            } finally {
                                destroyContact(contact);
                            }
                        } finally {
                            destroyPublicIdentity(opened.identity);
                            if (opened.profile.avatar !== undefined) {
                                zeroBytes(opened.profile.avatar);
                            }
                        }
                    } finally {
                        zeroBytes(encoded);
                    }
                });
            } finally {
                zeroBytes(cleanupPayload);
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
                const contacts = await new ContactBook(
                    account.identity,
                    this.#requireStore(),
                ).list();
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

    async close(): Promise<void> {
        return this.#serialize(async () => {
            if (this.#closed) return;
            await this.#stopRuntime();
            if (this.#store !== undefined) await this.#store.close();
            this.#store = undefined;
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

    #requireRuntime(): MurmurRuntime {
        if (this.#runtime === undefined) {
            throw new MurmurServiceError("service_not_running", "Murmur service is not running");
        }
        return this.#runtime;
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
        } finally {
            if (this.#runtime === runtime) this.#runtime = undefined;
            this.#relayUrls = [];
            destroyStoredMurmurAccount(runtime.account);
        }
    }

    async #syncLoop(runtime: MurmurRuntime): Promise<void> {
        const signal = runtime.controller.signal;
        while (!signal.aborted) {
            try {
                const result = await runtime.client.sync(this.#syncWaitMilliseconds, signal);
                if (signal.aborted) break;
                if (result.status === "reset") {
                    for (const reset of result.resets) {
                        await runtime.client.loadTopic(
                            reset.topic,
                            async (transaction, state) => {
                                for (const element of state.elements) {
                                    await this.#persistInboundPayload(
                                        runtime,
                                        transaction,
                                        element.bytes,
                                        Date.now(),
                                    );
                                }
                            },
                            reset.relayId,
                        );
                    }
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

    async #persistReceivedEvent(runtime: MurmurRuntime, received: ReceivedEvent): Promise<void> {
        const inbox = identityInboxTopic(runtime.account.identity);
        if (received.event.topic !== inbox) {
            await this.#requireStore().transaction(async (transaction) => {
                await this.#quarantine(transaction, received.event.payload, "unexpected-topic");
                await received.advanceCursor(transaction);
            });
            return;
        }
        await this.#requireStore().transaction(async (transaction) => {
            await this.#persistInboundPayload(
                runtime,
                transaction,
                received.event.payload,
                received.event.createdAt,
            );
            await received.advanceCursor(transaction);
        });
    }

    async #persistInboundPayload(
        runtime: MurmurRuntime,
        transaction: StoreTransaction,
        payload: Uint8Array,
        receivedAt: number,
    ): Promise<void> {
        if (isHandledRequestEnvelope(payload)) return;
        const id = payloadId(payload);
        const handled = await transaction.get(handledKey(id));
        if (handled !== undefined) {
            zeroBytes(handled);
            return;
        }
        const key = pendingKey(id);
        const existing = await transaction.get(key);
        if (existing !== undefined) {
            zeroBytes(existing);
            return;
        }
        const pendingCount = await this.#readPendingCount(transaction);
        if (pendingCount >= this.#maxPendingFriendRequests) {
            await this.#quarantine(transaction, payload, "pending-limit-reached");
            return;
        }
        let pending: StoredPendingRequest;
        try {
            const opened = decryptContactProfile(
                runtime.account.identity,
                decodeFriendRequestEnvelope(payload),
            );
            try {
                pending = openedProfileToPending(id, opened, receivedAt);
            } finally {
                destroyPublicIdentity(opened.identity);
                if (opened.profile.avatar !== undefined) zeroBytes(opened.profile.avatar);
                if (opened.privateData !== undefined) zeroBytes(opened.privateData);
            }
        } catch {
            await this.#quarantine(transaction, payload, "invalid-friend-request");
            return;
        }
        const encoded = encodeStoredPendingRequest(pending);
        const encodedCount = encodeStoredPendingRequestCount(pendingCount + 1);
        try {
            await transaction.set(key, encoded.slice());
            await transaction.set(PENDING_COUNT_KEY, encodedCount.slice());
        } finally {
            zeroBytes(encoded);
            zeroBytes(encodedCount);
        }
    }

    async #readPendingCount(transaction: StoreTransaction): Promise<number> {
        const encoded = await transaction.get(PENDING_COUNT_KEY);
        if (encoded === undefined) return 0;
        try {
            return decodeStoredPendingRequestCount(encoded);
        } finally {
            zeroBytes(encoded);
        }
    }

    async #decrementPendingCount(transaction: StoreTransaction): Promise<void> {
        const count = await this.#readPendingCount(transaction);
        const encoded = encodeStoredPendingRequestCount(Math.max(0, count - 1));
        try {
            await transaction.set(PENDING_COUNT_KEY, encoded.slice());
        } finally {
            zeroBytes(encoded);
        }
    }

    async #recordHandledRequest(
        transaction: StoreTransaction,
        id: string,
        answer: "accept" | "reject",
        answeredAt: number,
    ): Promise<void> {
        const encoded = encodeStoredHandledRequest({ answer, answeredAt, id, version: 1 });
        try {
            await transaction.set(handledKey(id), encoded.slice());
        } finally {
            zeroBytes(encoded);
        }
        const handled = await transaction.list(HANDLED_PREFIX);
        try {
            const expired = [...handled.entries()]
                .map(([key, value]) => ({
                    answeredAt: decodeStoredHandledRequest(value).answeredAt,
                    key,
                }))
                .sort(
                    (left, right) =>
                        left.answeredAt - right.answeredAt || left.key.localeCompare(right.key),
                )
                .slice(0, Math.max(0, handled.size - MAX_HANDLED_REQUESTS));
            for (const record of expired) await transaction.delete(record.key);
        } finally {
            for (const value of handled.values()) zeroBytes(value);
        }
    }

    async #publishPreparedOutbound(
        runtime: MurmurRuntime,
        key: string,
        prefix: string,
        limit: number,
        createEvent: () => SignedRelayEvent,
    ): Promise<boolean> {
        const store = this.#requireStore();
        let event: SignedRelayEvent;
        let publishedRelayIds: readonly string[] = [];
        const existing = await store.get(key);
        if (existing === undefined) {
            const retained = await store.list(prefix);
            try {
                if (retained.size >= limit) {
                    throw new MurmurServiceError(
                        "relay_unavailable",
                        "The Murmur outbound queue is full",
                    );
                }
            } finally {
                for (const value of retained.values()) zeroBytes(value);
            }
            event = createEvent();
            const encoded = encodeStoredOutboundEvent({ event, publishedRelayIds });
            try {
                await store.set(key, encoded.slice());
            } finally {
                zeroBytes(encoded);
            }
        } else {
            try {
                const stored = decodeStoredOutboundEvent(existing);
                event = stored.event;
                publishedRelayIds = stored.publishedRelayIds;
            } finally {
                zeroBytes(existing);
            }
        }

        try {
            const configuredRelayIds = new Set(runtime.transports.map((transport) => transport.id));
            const published = new Set(
                publishedRelayIds.filter((relayId) => configuredRelayIds.has(relayId)),
            );
            const pending = runtime.transports.filter((transport) => !published.has(transport.id));
            const attempts = await Promise.allSettled(
                pending.map(async (transport) => {
                    await transport.publish(event);
                    return transport.id;
                }),
            );
            for (const attempt of attempts) {
                if (attempt.status === "fulfilled") published.add(attempt.value);
            }
            const updated = encodeStoredOutboundEvent({
                event,
                publishedRelayIds: [...published],
            });
            try {
                await store.set(key, updated.slice());
            } finally {
                zeroBytes(updated);
            }
            return runtime.transports.every((transport) => published.has(transport.id));
        } finally {
            destroySignedRelayEvent(event);
        }
    }

    async #quarantine(
        transaction: StoreTransaction,
        payload: Uint8Array,
        reason: string,
    ): Promise<void> {
        const id = payloadId(payload);
        const record = utf8Encode(
            JSON.stringify({
                bytes: payload.byteLength,
                reason,
                version: 1,
            }),
        );
        try {
            await transaction.set(`${QUARANTINE_PREFIX}${id}`, record.slice());
            const records = await transaction.list(QUARANTINE_PREFIX);
            for (const value of records.values()) zeroBytes(value);
            const expired = [...records.keys()]
                .sort()
                .slice(0, Math.max(0, records.size - MAX_QUARANTINE_RECORDS));
            for (const key of expired) await transaction.delete(key);
        } finally {
            zeroBytes(record);
        }
    }
}
