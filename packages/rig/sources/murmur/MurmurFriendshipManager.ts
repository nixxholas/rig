import {
    ContactBook,
    createRelayEvent,
    decryptContactProfile,
    decryptPrivateMessageFromContact,
    destroyIdentity,
    equalRelayEvents,
    encodeBase64Url,
    encryptPrivateMessageForContact,
    encryptProfileForContact,
    generateIdentityKeyPair,
    hashBytes,
    identityId,
    identityInboxTopic,
    randomBytes,
    utf8Encode,
    zeroBytes,
    type Contact,
    type IdentityKeyPair,
    type IdentityProfile,
    type IdentityPublicKeys,
    type OpenedPrivateMessage,
    type OpenedProfile,
    type PrivateMessage,
    type RelayTransport,
    type SignedRelayEvent,
    type StoreTransaction,
} from "@slopus/murmur";

import { createEventIdFactory } from "../protocol/index.js";
import {
    decodeFriendshipControl,
    decodeFriendshipControlText,
    decodeFriendshipWireEnvelope,
    decodeStoredFriendship,
    decodeStoredFriendshipCount,
    decodeStoredGlobalFriendshipEvent,
    decodeStoredRelayOutbox,
    deserializeFriendshipIdentity,
    deserializeFriendshipProfile,
    encodeFriendshipCleanupEnvelope,
    encodeFriendshipControl,
    encodeFriendshipControlText,
    encodeFriendshipPrivateEnvelope,
    encodeFriendshipProfileEnvelope,
    encodeFriendshipQuarantine,
    encodeStoredFriendship,
    encodeStoredFriendshipCount,
    encodeStoredGlobalFriendshipEvent,
    encodeStoredRelayOutbox,
    serializeFriendshipIdentity,
    serializeFriendshipProfile,
    type FriendshipControl,
    type FriendshipDirection,
    type FriendshipHistory,
    type FriendshipState,
    type GlobalFriendshipReason,
    type StoredFriendship,
    type StoredGlobalFriendshipEvent,
} from "./impl/friendshipCodec.js";
import type { MurmurPagedStore } from "./types.js";

const RELATIONSHIP_PREFIX = "rig/murmur/friendships/v1/";
const RELATIONSHIP_COUNT_KEY = "rig/murmur/friendship-counts/v1/relationships";
const RELAY_OUTBOX_PREFIX = "rig/murmur/friendship-relay-outbox/v1/";
const RELAY_OUTBOX_COUNT_KEY = "rig/murmur/friendship-counts/v1/relay-outbox";
const GLOBAL_OUTBOX_PREFIX = "rig/murmur/friendship-global-outbox/v1/";
const GLOBAL_OUTBOX_COUNT_KEY = "rig/murmur/friendship-counts/v1/global-outbox";
const QUARANTINE_PREFIX = "rig/murmur/friendship-quarantine/v1/";
const MAX_RELATIONSHIPS = 10_000;
const MAX_RELAY_OUTBOX_RECORDS = 30_000;
const MAX_GLOBAL_OUTBOX_RECORDS = 10_000;
const MAX_QUARANTINE_RECORDS = 100;
const RELAY_OUTBOX_FLUSH_PAGE_SIZE = 32;
const GLOBAL_OUTBOX_DRAIN_PAGE_SIZE = 100;

export interface MurmurFriendship {
    readonly answeredAt?: number;
    readonly autoAcceptEligible: boolean;
    readonly direction: FriendshipDirection;
    readonly eventVersion: string;
    readonly firstSeenAt: number;
    readonly history: FriendshipHistory;
    readonly identity: IdentityPublicKeys;
    readonly profile?: IdentityProfile;
    readonly requestId?: string;
    readonly state: FriendshipState;
    readonly updatedAt: number;
}

export interface MurmurFriendshipStats {
    readonly acceptedRequests: number;
    readonly autoAcceptedRequests: number;
    readonly contacts: number;
    readonly incomingPending: number;
    readonly outgoingPending: number;
    readonly rejectedRequests: number;
}

export interface MurmurFriendshipChangedEvent {
    readonly createdAt: number;
    readonly data: {
        readonly direction: FriendshipDirection;
        readonly reason: GlobalFriendshipReason;
        readonly state: FriendshipState;
    };
    readonly id: string;
    readonly murmurPeerId: string;
    readonly type: "murmur_friendship_changed";
}

export interface MurmurFriendshipManagerOptions {
    readonly maxRelationships?: number;
    readonly now?: () => number;
    readonly publishGlobalEvent?: (event: MurmurFriendshipChangedEvent) => void | Promise<void>;
    readonly store: MurmurPagedStore;
}

export interface QueueMurmurFriendRequestResult {
    readonly friendship: MurmurFriendship;
    readonly queued: boolean;
}

export interface AnswerMurmurFriendRequestResult {
    readonly answer: "accept" | "reject";
    readonly contact?: Contact;
    readonly friendship: MurmurFriendship;
}

export interface ProcessMurmurFriendshipPayloadResult {
    readonly friendship?: MurmurFriendship;
    readonly status: "accepted" | "ignored" | "pending" | "quarantined" | "rejected";
}

export interface FlushMurmurFriendshipOutboxResult {
    readonly completed: number;
    readonly pending: number;
}

function relationshipKey(peerId: string): string {
    return `${RELATIONSHIP_PREFIX}${peerId}`;
}

function requestRelayOutboxKey(peerId: string, requestId: string): string {
    return `${RELAY_OUTBOX_PREFIX}request/${peerId}/${requestId}`;
}

function answerRelayOutboxKey(peerId: string, requestId: string, answer: string): string {
    return `${RELAY_OUTBOX_PREFIX}answer/${peerId}/${requestId}/${answer}`;
}

function cleanupRelayOutboxKey(elementId: string): string {
    return `${RELAY_OUTBOX_PREFIX}cleanup/${elementId}`;
}

function requestListElementId(requestId: string): string {
    return `friend-request:${requestId}`;
}

function answerListElementId(requestId: string, answer: "accept" | "reject"): string {
    return `friend-answer:${requestId}:${answer}`;
}

function increment(value: number): number {
    return Math.min(Number.MAX_SAFE_INTEGER, value + 1);
}

function addCount(left: number, right: number): number {
    return Math.min(Number.MAX_SAFE_INTEGER, left + right);
}

function emptyHistory(): FriendshipHistory {
    return { accepted: 0, autoAccepted: 0, received: 0, rejected: 0, sent: 0 };
}

function updateHistory(
    history: FriendshipHistory,
    field: keyof FriendshipHistory,
): FriendshipHistory {
    return { ...history, [field]: increment(history[field]) };
}

function destroyPublicIdentity(identity: IdentityPublicKeys): void {
    zeroBytes(identity.signingKey);
    zeroBytes(identity.encryptionKey);
}

function destroyProfile(profile: IdentityProfile | undefined): void {
    if (profile?.avatar !== undefined) zeroBytes(profile.avatar);
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

function stableDigest(value: string): string {
    const bytes = utf8Encode(value);
    const digest = hashBytes(bytes);
    try {
        return encodeBase64Url(digest);
    } finally {
        zeroBytes(bytes);
        zeroBytes(digest);
    }
}

function stablePrivateMessageId(requestId: string, answer: "accept" | "reject"): string {
    const bytes = utf8Encode(`rig/murmur/friend-answer/v1/${requestId}/${answer}`);
    const digest = hashBytes(bytes);
    const truncated = digest.slice(0, 24);
    try {
        return encodeBase64Url(truncated);
    } finally {
        zeroBytes(bytes);
        zeroBytes(digest);
        zeroBytes(truncated);
    }
}

function createRequestId(): string {
    const bytes = randomBytes(24);
    try {
        return encodeBase64Url(bytes);
    } finally {
        zeroBytes(bytes);
    }
}

function toPublicFriendship(stored: StoredFriendship): MurmurFriendship {
    let identity: IdentityPublicKeys | undefined;
    let profile: IdentityProfile | undefined;
    try {
        identity = deserializeFriendshipIdentity(stored.identity);
        profile =
            stored.profile === undefined ? undefined : deserializeFriendshipProfile(stored.profile);
        return {
            ...(stored.answeredAt === undefined ? {} : { answeredAt: stored.answeredAt }),
            autoAcceptEligible: stored.autoAcceptEligible,
            direction: stored.direction,
            eventVersion: stored.eventVersion,
            firstSeenAt: stored.firstSeenAt,
            history: { ...stored.history },
            identity,
            ...(profile === undefined ? {} : { profile }),
            ...(stored.requestId === undefined ? {} : { requestId: stored.requestId }),
            state: stored.state,
            updatedAt: stored.updatedAt,
        };
    } catch (error: unknown) {
        if (identity !== undefined) destroyPublicIdentity(identity);
        destroyProfile(profile);
        throw error;
    }
}

/** Zero byte-backed fields returned by this manager when the caller is finished. */
export function destroyMurmurFriendship(friendship: MurmurFriendship): void {
    destroyPublicIdentity(friendship.identity);
    destroyProfile(friendship.profile);
}

/** Zero byte-backed fields returned by ContactBook when the caller is finished. */
export function destroyMurmurFriendshipContact(contact: Contact): void {
    destroyPublicIdentity(contact.identity);
    destroyProfile(contact.profile);
}

/**
 * Durable one-record-per-peer friendship state machine.
 *
 * Semantic state is always committed before either relay or global outboxes
 * are drained. Relay events are prepared once and reused byte-for-byte across
 * retries, including partial multi-relay publication.
 */
export class MurmurFriendshipManager {
    readonly #createEventId: () => string;
    readonly #maxRelationships: number;
    readonly #now: () => number;
    readonly #publishGlobalEvent:
        | ((event: MurmurFriendshipChangedEvent) => void | Promise<void>)
        | undefined;
    readonly #store: MurmurPagedStore;
    #relayOutboxAfter: string | undefined;

    constructor(options: MurmurFriendshipManagerOptions) {
        if (
            options.maxRelationships !== undefined &&
            (!Number.isSafeInteger(options.maxRelationships) ||
                options.maxRelationships < 1 ||
                options.maxRelationships > MAX_RELATIONSHIPS)
        ) {
            throw new Error("Murmur friendship limit must be between 1 and 10,000");
        }
        this.#maxRelationships = options.maxRelationships ?? MAX_RELATIONSHIPS;
        this.#now = options.now ?? Date.now;
        this.#createEventId = createEventIdFactory({ now: this.#now });
        this.#publishGlobalEvent = options.publishGlobalEvent;
        this.#store = options.store;
    }

    async queueFriendRequest(
        owner: IdentityKeyPair,
        ownerProfile: IdentityProfile,
        peer: IdentityPublicKeys,
    ): Promise<QueueMurmurFriendRequestResult> {
        const peerId = identityId(peer);
        if (peerId === identityId(owner)) throw new Error("An identity cannot befriend itself");
        const requestedAt = this.#now();
        const result = await this.#store.transaction(async (transaction) => {
            const current = await this.#readStoredFriendship(transaction, peerId);
            const now = Math.max(requestedAt, current?.updatedAt ?? 0);
            if (current?.state === "friends" || current?.state === "outgoing_pending") {
                return { friendship: current, queued: false };
            }
            if (current?.state === "incoming_pending") {
                const accepted = await this.#answerStoredIncoming(
                    transaction,
                    owner,
                    ownerProfile,
                    current,
                    "accept",
                    true,
                    now,
                );
                if (accepted.contact !== undefined) {
                    destroyMurmurFriendshipContact(accepted.contact);
                }
                return { friendship: accepted.friendship, queued: true };
            }

            const requestId = createRequestId();
            const eventVersion = this.#createEventId();
            const friendship: StoredFriendship = {
                autoAcceptEligible: true,
                direction: "outgoing",
                eventVersion,
                firstSeenAt: current?.firstSeenAt ?? now,
                history: updateHistory(current?.history ?? emptyHistory(), "sent"),
                identity: serializeFriendshipIdentity(peer),
                ...(current?.profile === undefined ? {} : { profile: current.profile }),
                requestId,
                state: "outgoing_pending",
                updatedAt: now,
                version: 1,
            };
            await this.#saveStoredFriendship(transaction, friendship);
            await this.#queueProfileRelayEvent(
                transaction,
                requestRelayOutboxKey(peerId, requestId),
                owner,
                ownerProfile,
                peer,
                {
                    action: "request",
                    eventVersion,
                    kind: "rig.murmur.friendship-control.v1",
                    requestId,
                    sentAt: now,
                    version: 1,
                },
                requestListElementId(requestId),
            );
            await this.#queueGlobalEvent(transaction, friendship, "request_sent", now);
            return { friendship, queued: true };
        });
        await this.drainGlobalEventOutbox();
        return {
            friendship: toPublicFriendship(result.friendship),
            queued: result.queued,
        };
    }

    async answerIncoming(
        owner: IdentityKeyPair,
        ownerProfile: IdentityProfile,
        peerId: string,
        answer: "accept" | "reject",
    ): Promise<AnswerMurmurFriendRequestResult> {
        const requestedAt = this.#now();
        const result = await this.#store.transaction(async (transaction) => {
            const friendship = await this.#readStoredFriendship(transaction, peerId);
            if (friendship?.state !== "incoming_pending") {
                throw new Error("Murmur friend request not found");
            }
            return this.#answerStoredIncoming(
                transaction,
                owner,
                ownerProfile,
                friendship,
                answer,
                false,
                Math.max(requestedAt, friendship.updatedAt),
            );
        });
        try {
            await this.drainGlobalEventOutbox();
        } catch (error: unknown) {
            if (result.contact !== undefined) destroyMurmurFriendshipContact(result.contact);
            throw error;
        }
        return {
            answer,
            ...(result.contact === undefined ? {} : { contact: result.contact }),
            friendship: toPublicFriendship(result.friendship),
        };
    }

    async processInboundPayload(
        owner: IdentityKeyPair,
        ownerProfile: IdentityProfile,
        transaction: StoreTransaction,
        payload: Uint8Array,
        receivedAt: number,
    ): Promise<ProcessMurmurFriendshipPayloadResult> {
        let envelope: ReturnType<typeof decodeFriendshipWireEnvelope>;
        try {
            envelope = decodeFriendshipWireEnvelope(payload);
        } catch {
            await this.#quarantine(transaction, payload, "invalid-envelope", receivedAt);
            return { status: "quarantined" };
        }
        if (envelope.kind === "cleanup") return { status: "ignored" };

        if (envelope.kind === "profile") {
            let opened: OpenedProfile | undefined;
            let control: FriendshipControl;
            let storedProfile: NonNullable<StoredFriendship["profile"]>;
            try {
                opened = decryptContactProfile(owner, envelope.encrypted);
                if (opened.privateData === undefined) throw new Error("Missing friendship control");
                control = decodeFriendshipControl(opened.privateData);
                if (control.action === "reject") throw new Error("Invalid profile answer");
            } catch {
                if (opened !== undefined) {
                    destroyPublicIdentity(opened.identity);
                    destroyProfile(opened.profile);
                    if (opened.privateData !== undefined) zeroBytes(opened.privateData);
                }
                await this.#quarantine(transaction, payload, "invalid-profile-message", receivedAt);
                return { status: "quarantined" };
            }
            try {
                storedProfile = serializeFriendshipProfile(opened.profile);
            } catch {
                destroyPublicIdentity(opened.identity);
                destroyProfile(opened.profile);
                if (opened.privateData !== undefined) zeroBytes(opened.privateData);
                await this.#quarantine(transaction, payload, "unsupported-profile", receivedAt);
                return { status: "quarantined" };
            }
            try {
                if (control.action === "request") {
                    return await this.#processInboundRequest(
                        transaction,
                        owner,
                        ownerProfile,
                        opened,
                        storedProfile,
                        control,
                        receivedAt,
                        payload,
                    );
                }
                return await this.#processInboundAcceptance(
                    transaction,
                    owner,
                    opened,
                    storedProfile,
                    control,
                    receivedAt,
                    payload,
                );
            } finally {
                destroyPublicIdentity(opened.identity);
                destroyProfile(opened.profile);
                if (opened.privateData !== undefined) zeroBytes(opened.privateData);
            }
        }

        let opened: OpenedPrivateMessage | undefined;
        let control: FriendshipControl;
        try {
            opened = decryptPrivateMessageFromContact(owner, envelope.encrypted);
            control = decodeFriendshipControlText(opened.message.text);
            if (
                control.action !== "reject" ||
                opened.message.attachments.length !== 0 ||
                opened.message.sentAt !== control.sentAt ||
                opened.message.id !== stablePrivateMessageId(control.requestId, "reject")
            ) {
                throw new Error("Invalid friendship rejection");
            }
        } catch {
            if (opened !== undefined) {
                destroyPublicIdentity(opened.identity);
                for (const attachment of opened.message.attachments) {
                    zeroBytes(attachment.key);
                    zeroBytes(attachment.nonce);
                }
            }
            await this.#quarantine(transaction, payload, "invalid-private-message", receivedAt);
            return { status: "quarantined" };
        }
        try {
            return await this.#processInboundRejection(
                transaction,
                owner,
                opened,
                control,
                receivedAt,
                payload,
            );
        } finally {
            destroyPublicIdentity(opened.identity);
            for (const attachment of opened.message.attachments) {
                zeroBytes(attachment.key);
                zeroBytes(attachment.nonce);
            }
        }
    }

    async listFriendships(): Promise<readonly MurmurFriendship[]> {
        const records = await this.#readAllStoredFriendships();
        return records.map(toPublicFriendship);
    }

    async listPendingIncoming(): Promise<readonly MurmurFriendship[]> {
        const records = await this.#readAllStoredFriendships();
        return records
            .filter((record) => record.state === "incoming_pending")
            .sort(
                (left, right) =>
                    left.updatedAt - right.updatedAt ||
                    left.identity.signingKey.localeCompare(right.identity.signingKey),
            )
            .map(toPublicFriendship);
    }

    async listContacts(owner: IdentityPublicKeys): Promise<readonly Contact[]> {
        return new ContactBook(owner, this.#store).list();
    }

    async stats(): Promise<MurmurFriendshipStats> {
        const records = await this.#readAllStoredFriendships();
        let acceptedRequests = 0;
        let autoAcceptedRequests = 0;
        let contacts = 0;
        let incomingPending = 0;
        let outgoingPending = 0;
        let rejectedRequests = 0;
        for (const record of records) {
            if (record.state === "friends") contacts += 1;
            if (record.state === "incoming_pending") incomingPending += 1;
            if (record.state === "outgoing_pending") outgoingPending += 1;
            acceptedRequests = addCount(acceptedRequests, record.history.accepted);
            autoAcceptedRequests = addCount(autoAcceptedRequests, record.history.autoAccepted);
            rejectedRequests = addCount(rejectedRequests, record.history.rejected);
        }
        return {
            acceptedRequests,
            autoAcceptedRequests,
            contacts,
            incomingPending,
            outgoingPending,
            rejectedRequests,
        };
    }

    async flushRelayOutbox(
        transports: readonly RelayTransport[],
    ): Promise<FlushMurmurFriendshipOutboxResult> {
        if (
            transports.length > 16 ||
            new Set(transports.map((transport) => transport.id)).size !== transports.length ||
            transports.some((transport) => transport.id.length < 1 || transport.id.length > 128)
        ) {
            throw new Error("Murmur friendship relays must have at most 16 unique IDs");
        }
        let retained = await this.#store.listPage(
            RELAY_OUTBOX_PREFIX,
            this.#relayOutboxAfter,
            RELAY_OUTBOX_FLUSH_PAGE_SIZE,
        );
        if (retained.size === 0 && this.#relayOutboxAfter !== undefined) {
            this.#relayOutboxAfter = undefined;
            retained = await this.#store.listPage(
                RELAY_OUTBOX_PREFIX,
                undefined,
                RELAY_OUTBOX_FLUSH_PAGE_SIZE,
            );
        }
        this.#relayOutboxAfter = [...retained.keys()].at(-1);
        let completed = 0;
        try {
            for (const [key, bytes] of retained) {
                const stored = decodeStoredRelayOutbox(bytes);
                try {
                    const configured = new Set(transports.map((transport) => transport.id));
                    const published = new Set(
                        stored.publishedRelayIds.filter((relayId) => configured.has(relayId)),
                    );
                    for (const transport of transports) {
                        if (published.has(transport.id)) continue;
                        try {
                            await transport.publish(stored.event);
                        } catch {
                            // A later flush reuses this exact signed event.
                            continue;
                        }
                        published.add(transport.id);
                        await this.#persistRelayConfirmation(key, stored.event, transport.id);
                    }
                    if (
                        transports.length > 0 &&
                        transports.every((transport) => published.has(transport.id))
                    ) {
                        await this.#deleteRelayOutbox(key);
                        completed += 1;
                    }
                } finally {
                    destroySignedRelayEvent(stored.event);
                }
            }
        } finally {
            for (const bytes of retained.values()) zeroBytes(bytes);
        }
        return {
            completed,
            pending: await this.#readStoredCount(this.#store, RELAY_OUTBOX_COUNT_KEY),
        };
    }

    async drainGlobalEventOutbox(): Promise<number> {
        if (this.#publishGlobalEvent === undefined) return 0;
        const retained = await this.#store.listPage(
            GLOBAL_OUTBOX_PREFIX,
            undefined,
            GLOBAL_OUTBOX_DRAIN_PAGE_SIZE,
        );
        let published = 0;
        try {
            const records = [...retained.entries()]
                .map(([key, bytes]) => ({
                    key,
                    stored: decodeStoredGlobalFriendshipEvent(bytes),
                }))
                .sort(
                    (left, right) =>
                        left.stored.createdAt - right.stored.createdAt ||
                        left.key.localeCompare(right.key),
                );
            for (const { key, stored } of records) {
                await this.#publishGlobalEvent({
                    createdAt: stored.createdAt,
                    data: stored.data,
                    id: stored.id,
                    murmurPeerId: stored.murmurPeerId,
                    type: stored.type,
                });
                await this.#deleteGlobalOutbox(key);
                published += 1;
            }
        } finally {
            for (const bytes of retained.values()) zeroBytes(bytes);
        }
        return published;
    }

    async #processInboundRequest(
        transaction: StoreTransaction,
        owner: IdentityKeyPair,
        ownerProfile: IdentityProfile,
        opened: OpenedProfile,
        storedProfile: NonNullable<StoredFriendship["profile"]>,
        control: FriendshipControl,
        receivedAt: number,
        payload: Uint8Array,
    ): Promise<ProcessMurmurFriendshipPayloadResult> {
        const peerId = identityId(opened.identity);
        if (peerId === identityId(owner)) {
            return { status: "ignored" };
        }
        const current = await this.#readStoredFriendship(transaction, peerId);
        if (
            current === undefined &&
            (await this.#readStoredCount(transaction, RELATIONSHIP_COUNT_KEY)) >=
                this.#maxRelationships
        ) {
            await this.#quarantine(transaction, payload, "relationship-limit-reached", receivedAt);
            return { status: "quarantined" };
        }
        if (
            current !== undefined &&
            current.requestId === control.requestId &&
            current.state !== "outgoing_pending"
        ) {
            return { friendship: toPublicFriendship(current), status: "ignored" };
        }
        const now = Math.max(current?.updatedAt ?? 0, receivedAt, control.sentAt);
        const shouldAutoAccept =
            current !== undefined &&
            current.autoAcceptEligible &&
            (current.state === "outgoing_pending" || current.state === "rejected_outgoing");
        if (
            (shouldAutoAccept || current?.state === "friends") &&
            !(await this.#hasRelayOutboxCapacity(transaction, [
                answerRelayOutboxKey(peerId, control.requestId, "accept"),
                cleanupRelayOutboxKey(requestListElementId(control.requestId)),
            ]))
        ) {
            await this.#quarantine(transaction, payload, "relay-outbox-full", receivedAt);
            return { status: "quarantined" };
        }
        let history = updateHistory(current?.history ?? emptyHistory(), "received");
        if (shouldAutoAccept) {
            history = updateHistory(updateHistory(history, "accepted"), "autoAccepted");
            const contact = await this.#saveSanitizedContact(
                transaction,
                owner,
                opened.identity,
                storedProfile,
                now,
            );
            destroyMurmurFriendshipContact(contact);
            const friendship: StoredFriendship = {
                answeredAt: now,
                autoAcceptEligible: false,
                direction: "mutual",
                eventVersion: this.#createEventId(),
                firstSeenAt: current?.firstSeenAt ?? now,
                history,
                identity: serializeFriendshipIdentity(opened.identity),
                profile: storedProfile,
                requestId: control.requestId,
                state: "friends",
                updatedAt: now,
                version: 1,
            };
            await this.#saveStoredFriendship(transaction, friendship);
            await this.#queueAnswerRelayEvents(
                transaction,
                owner,
                ownerProfile,
                opened.identity,
                friendship,
                "accept",
                now,
            );
            await this.#queueGlobalEvent(transaction, friendship, "auto_accepted", now, "incoming");
            return { friendship: toPublicFriendship(friendship), status: "accepted" };
        }
        if (current?.state === "friends") {
            const contact = await this.#saveSanitizedContact(
                transaction,
                owner,
                opened.identity,
                storedProfile,
                now,
            );
            destroyMurmurFriendshipContact(contact);
            const friendship: StoredFriendship = {
                ...current,
                eventVersion: this.#createEventId(),
                history,
                identity: serializeFriendshipIdentity(opened.identity),
                profile: storedProfile,
                requestId: control.requestId,
                updatedAt: now,
            };
            await this.#saveStoredFriendship(transaction, friendship);
            await this.#queueAnswerRelayEvents(
                transaction,
                owner,
                ownerProfile,
                opened.identity,
                friendship,
                "accept",
                now,
            );
            await this.#queueGlobalEvent(transaction, friendship, "profile_updated", now);
            return { friendship: toPublicFriendship(friendship), status: "accepted" };
        }
        const friendship: StoredFriendship = {
            autoAcceptEligible: false,
            direction: "incoming",
            eventVersion: this.#createEventId(),
            firstSeenAt: current?.firstSeenAt ?? now,
            history,
            identity: serializeFriendshipIdentity(opened.identity),
            profile: storedProfile,
            requestId: control.requestId,
            state: "incoming_pending",
            updatedAt: now,
            version: 1,
        };
        await this.#saveStoredFriendship(transaction, friendship);
        await this.#queueGlobalEvent(transaction, friendship, "request_received", now);
        return { friendship: toPublicFriendship(friendship), status: "pending" };
    }

    async #processInboundAcceptance(
        transaction: StoreTransaction,
        owner: IdentityKeyPair,
        opened: OpenedProfile,
        storedProfile: NonNullable<StoredFriendship["profile"]>,
        control: FriendshipControl,
        receivedAt: number,
        payload: Uint8Array,
    ): Promise<ProcessMurmurFriendshipPayloadResult> {
        const peerId = identityId(opened.identity);
        const current = await this.#readStoredFriendship(transaction, peerId);
        if (
            !(await this.#hasRelayOutboxCapacity(transaction, [
                cleanupRelayOutboxKey(answerListElementId(control.requestId, "accept")),
            ]))
        ) {
            await this.#quarantine(transaction, payload, "relay-outbox-full", receivedAt);
            return { status: "quarantined" };
        }
        await this.#queueCleanupRelayEvent(
            transaction,
            owner,
            answerListElementId(control.requestId, "accept"),
            receivedAt,
        );
        if (
            current === undefined ||
            current.requestId !== control.requestId ||
            (current.state !== "outgoing_pending" && current.state !== "friends")
        ) {
            return {
                ...(current === undefined ? {} : { friendship: toPublicFriendship(current) }),
                status: "ignored",
            };
        }
        const now = Math.max(current.updatedAt, receivedAt, control.sentAt);
        const contact = await this.#saveSanitizedContact(
            transaction,
            owner,
            opened.identity,
            storedProfile,
            now,
        );
        destroyMurmurFriendshipContact(contact);
        if (current.state === "friends") {
            const updated: StoredFriendship = {
                ...current,
                eventVersion: this.#createEventId(),
                identity: serializeFriendshipIdentity(opened.identity),
                profile: storedProfile,
                updatedAt: Math.max(current.updatedAt, now),
            };
            await this.#saveStoredFriendship(transaction, updated);
            return { friendship: toPublicFriendship(updated), status: "ignored" };
        }
        const friendship: StoredFriendship = {
            ...current,
            answeredAt: now,
            autoAcceptEligible: false,
            direction: "mutual",
            eventVersion: this.#createEventId(),
            history: updateHistory(current.history, "accepted"),
            identity: serializeFriendshipIdentity(opened.identity),
            profile: storedProfile,
            state: "friends",
            updatedAt: now,
        };
        await this.#saveStoredFriendship(transaction, friendship);
        await this.#queueGlobalEvent(transaction, friendship, "accepted", now, "outgoing");
        return { friendship: toPublicFriendship(friendship), status: "accepted" };
    }

    async #processInboundRejection(
        transaction: StoreTransaction,
        owner: IdentityKeyPair,
        opened: OpenedPrivateMessage,
        control: FriendshipControl,
        receivedAt: number,
        payload: Uint8Array,
    ): Promise<ProcessMurmurFriendshipPayloadResult> {
        const peerId = identityId(opened.identity);
        const current = await this.#readStoredFriendship(transaction, peerId);
        if (
            !(await this.#hasRelayOutboxCapacity(transaction, [
                cleanupRelayOutboxKey(answerListElementId(control.requestId, "reject")),
            ]))
        ) {
            await this.#quarantine(transaction, payload, "relay-outbox-full", receivedAt);
            return { status: "quarantined" };
        }
        await this.#queueCleanupRelayEvent(
            transaction,
            owner,
            answerListElementId(control.requestId, "reject"),
            receivedAt,
        );
        if (
            current === undefined ||
            current.requestId !== control.requestId ||
            current.state !== "outgoing_pending"
        ) {
            return {
                ...(current === undefined ? {} : { friendship: toPublicFriendship(current) }),
                status: "ignored",
            };
        }
        const now = Math.max(current.updatedAt, receivedAt, control.sentAt);
        const friendship: StoredFriendship = {
            ...current,
            answeredAt: now,
            autoAcceptEligible: true,
            direction: "outgoing",
            eventVersion: this.#createEventId(),
            history: updateHistory(current.history, "rejected"),
            state: "rejected_outgoing",
            updatedAt: now,
        };
        await this.#saveStoredFriendship(transaction, friendship);
        await this.#queueGlobalEvent(transaction, friendship, "rejected", now, "outgoing");
        return { friendship: toPublicFriendship(friendship), status: "rejected" };
    }

    async #answerStoredIncoming(
        transaction: StoreTransaction,
        owner: IdentityKeyPair,
        ownerProfile: IdentityProfile,
        current: StoredFriendship,
        answer: "accept" | "reject",
        autoAccepted: boolean,
        now: number,
    ): Promise<{
        readonly contact?: Contact;
        readonly friendship: StoredFriendship;
    }> {
        if (
            current.state !== "incoming_pending" ||
            current.requestId === undefined ||
            current.profile === undefined
        ) {
            throw new Error("Murmur friend request is no longer pending");
        }
        const peer = deserializeFriendshipIdentity(current.identity);
        let profile: IdentityProfile | undefined;
        let contact: Contact | undefined;
        try {
            profile = deserializeFriendshipProfile(current.profile);
            let history = updateHistory(
                current.history,
                answer === "accept" ? "accepted" : "rejected",
            );
            if (autoAccepted) history = updateHistory(history, "autoAccepted");
            const friendship: StoredFriendship = {
                ...current,
                answeredAt: now,
                autoAcceptEligible: false,
                direction: answer === "accept" ? "mutual" : "incoming",
                eventVersion: this.#createEventId(),
                history,
                state: answer === "accept" ? "friends" : "rejected_incoming",
                updatedAt: now,
            };
            if (answer === "accept") {
                contact = await new ContactBook(owner, this.#store).saveInTransaction(
                    transaction,
                    { identity: peer, profile },
                    now,
                );
            }
            await this.#saveStoredFriendship(transaction, friendship);
            await this.#queueAnswerRelayEvents(
                transaction,
                owner,
                ownerProfile,
                peer,
                friendship,
                answer,
                now,
            );
            await this.#queueGlobalEvent(
                transaction,
                friendship,
                autoAccepted ? "auto_accepted" : answer === "accept" ? "accepted" : "rejected",
                now,
                "incoming",
            );
            return { ...(contact === undefined ? {} : { contact }), friendship };
        } catch (error: unknown) {
            if (contact !== undefined) destroyMurmurFriendshipContact(contact);
            throw error;
        } finally {
            destroyPublicIdentity(peer);
            destroyProfile(profile);
        }
    }

    async #saveSanitizedContact(
        transaction: StoreTransaction,
        owner: IdentityKeyPair,
        identity: IdentityPublicKeys,
        storedProfile: NonNullable<StoredFriendship["profile"]>,
        now: number,
    ): Promise<Contact> {
        const profile = deserializeFriendshipProfile(storedProfile);
        try {
            return await new ContactBook(owner, this.#store).saveInTransaction(
                transaction,
                { identity, profile },
                now,
            );
        } finally {
            destroyProfile(profile);
        }
    }

    async #queueAnswerRelayEvents(
        transaction: StoreTransaction,
        owner: IdentityKeyPair,
        ownerProfile: IdentityProfile,
        peer: IdentityPublicKeys,
        friendship: StoredFriendship,
        answer: "accept" | "reject",
        now: number,
    ): Promise<void> {
        const requestId = friendship.requestId;
        if (requestId === undefined) throw new Error("Answered friendship has no request ID");
        const control: FriendshipControl = {
            action: answer,
            eventVersion: friendship.eventVersion,
            kind: "rig.murmur.friendship-control.v1",
            requestId,
            sentAt: now,
            version: 1,
        };
        const peerId = identityId(peer);
        if (answer === "accept") {
            await this.#queueProfileRelayEvent(
                transaction,
                answerRelayOutboxKey(peerId, requestId, answer),
                owner,
                ownerProfile,
                peer,
                control,
                answerListElementId(requestId, answer),
            );
        } else {
            await this.#queuePrivateRelayEvent(
                transaction,
                answerRelayOutboxKey(peerId, requestId, answer),
                owner,
                peer,
                control,
                answerListElementId(requestId, answer),
            );
        }
        await this.#queueCleanupRelayEvent(
            transaction,
            owner,
            requestListElementId(requestId),
            now,
        );
    }

    async #queueProfileRelayEvent(
        transaction: StoreTransaction,
        outboxKey: string,
        owner: IdentityKeyPair,
        ownerProfile: IdentityProfile,
        recipient: IdentityPublicKeys,
        control: FriendshipControl,
        listElementId: string,
    ): Promise<void> {
        await this.#queueRelayEvent(transaction, outboxKey, () => {
            const privateData = encodeFriendshipControl(control);
            let payload: Uint8Array | undefined;
            try {
                payload = encodeFriendshipProfileEnvelope(
                    encryptProfileForContact(owner, recipient, ownerProfile, privateData),
                );
                return this.#createEphemeralRelayEvent(
                    identityInboxTopic(recipient),
                    payload,
                    [{ bytes: payload, id: listElementId, op: "append" }],
                    control.sentAt,
                );
            } finally {
                zeroBytes(privateData);
                if (payload !== undefined) zeroBytes(payload);
            }
        });
    }

    async #queuePrivateRelayEvent(
        transaction: StoreTransaction,
        outboxKey: string,
        owner: IdentityKeyPair,
        recipient: IdentityPublicKeys,
        control: FriendshipControl,
        listElementId: string,
    ): Promise<void> {
        await this.#queueRelayEvent(transaction, outboxKey, () => {
            const message: PrivateMessage = {
                attachments: [],
                id: stablePrivateMessageId(control.requestId, "reject"),
                sentAt: control.sentAt,
                text: encodeFriendshipControlText(control),
                version: 1,
            };
            const payload = encodeFriendshipPrivateEnvelope(
                encryptPrivateMessageForContact(owner, recipient, message),
            );
            try {
                return this.#createEphemeralRelayEvent(
                    identityInboxTopic(recipient),
                    payload,
                    [{ bytes: payload, id: listElementId, op: "append" }],
                    control.sentAt,
                );
            } finally {
                zeroBytes(payload);
            }
        });
    }

    async #queueCleanupRelayEvent(
        transaction: StoreTransaction,
        owner: IdentityKeyPair,
        elementId: string,
        now: number,
    ): Promise<void> {
        await this.#queueRelayEvent(transaction, cleanupRelayOutboxKey(elementId), () => {
            const payload = encodeFriendshipCleanupEnvelope(elementId);
            try {
                return this.#createEphemeralRelayEvent(
                    identityInboxTopic(owner),
                    payload,
                    [{ id: elementId, op: "delete" }],
                    now,
                );
            } finally {
                zeroBytes(payload);
            }
        });
    }

    #createEphemeralRelayEvent(
        topic: string,
        payload: Uint8Array,
        list: NonNullable<SignedRelayEvent["list"]>,
        now: number,
    ): SignedRelayEvent {
        const author = generateIdentityKeyPair();
        try {
            return createRelayEvent(author, topic, payload, { list }, now);
        } finally {
            destroyIdentity(author);
        }
    }

    async #queueRelayEvent(
        transaction: StoreTransaction,
        key: string,
        create: () => SignedRelayEvent,
    ): Promise<void> {
        const existing = await transaction.get(key);
        if (existing !== undefined) {
            zeroBytes(existing);
            return;
        }
        const retainedCount = await this.#readStoredCount(transaction, RELAY_OUTBOX_COUNT_KEY);
        if (retainedCount >= MAX_RELAY_OUTBOX_RECORDS) {
            throw new Error("Murmur friendship relay outbox is full");
        }
        const event = create();
        try {
            const encoded = encodeStoredRelayOutbox({ event, publishedRelayIds: [] });
            try {
                await transaction.set(key, encoded.slice());
                await this.#writeStoredCount(
                    transaction,
                    RELAY_OUTBOX_COUNT_KEY,
                    increment(retainedCount),
                );
            } finally {
                zeroBytes(encoded);
            }
        } finally {
            destroySignedRelayEvent(event);
        }
    }

    async #hasRelayOutboxCapacity(
        transaction: StoreTransaction,
        keys: readonly string[],
    ): Promise<boolean> {
        const uniqueKeys = new Set(keys);
        let required = 0;
        for (const key of uniqueKeys) {
            const existing = await transaction.get(key);
            if (existing === undefined) {
                required += 1;
            } else {
                zeroBytes(existing);
            }
        }
        const retainedCount = await this.#readStoredCount(transaction, RELAY_OUTBOX_COUNT_KEY);
        return retainedCount + required <= MAX_RELAY_OUTBOX_RECORDS;
    }

    async #deleteRelayOutbox(key: string): Promise<void> {
        await this.#store.transaction(async (transaction) => {
            const existing = await transaction.get(key);
            if (existing === undefined) return;
            zeroBytes(existing);
            const retainedCount = await this.#readStoredCount(transaction, RELAY_OUTBOX_COUNT_KEY);
            if (retainedCount < 1) {
                throw new Error("Murmur friendship relay outbox count is inconsistent");
            }
            await transaction.delete(key);
            await this.#writeStoredCount(transaction, RELAY_OUTBOX_COUNT_KEY, retainedCount - 1);
        });
    }

    async #deleteGlobalOutbox(key: string): Promise<void> {
        await this.#store.transaction(async (transaction) => {
            const existing = await transaction.get(key);
            if (existing === undefined) return;
            zeroBytes(existing);
            const retainedCount = await this.#readStoredCount(transaction, GLOBAL_OUTBOX_COUNT_KEY);
            if (retainedCount < 1) {
                throw new Error("Murmur friendship global outbox count is inconsistent");
            }
            await transaction.delete(key);
            await this.#writeStoredCount(transaction, GLOBAL_OUTBOX_COUNT_KEY, retainedCount - 1);
        });
    }

    async #readStoredCount(transaction: StoreTransaction, key: string): Promise<number> {
        const encoded = await transaction.get(key);
        if (encoded === undefined) return 0;
        try {
            return decodeStoredFriendshipCount(encoded);
        } finally {
            zeroBytes(encoded);
        }
    }

    async #writeStoredCount(
        transaction: StoreTransaction,
        key: string,
        count: number,
    ): Promise<void> {
        const encoded = encodeStoredFriendshipCount(count);
        try {
            await transaction.set(key, encoded.slice());
        } finally {
            zeroBytes(encoded);
        }
    }

    async #persistRelayConfirmation(
        key: string,
        event: SignedRelayEvent,
        relayId: string,
    ): Promise<void> {
        await this.#store.transaction(async (transaction) => {
            const currentBytes = await transaction.get(key);
            if (currentBytes === undefined) return;
            let current: ReturnType<typeof decodeStoredRelayOutbox>;
            try {
                current = decodeStoredRelayOutbox(currentBytes);
            } finally {
                zeroBytes(currentBytes);
            }
            try {
                if (!equalRelayEvents(current.event, event)) {
                    throw new Error("Murmur friendship relay outbox event changed");
                }
                const publishedRelayIds = new Set(current.publishedRelayIds);
                publishedRelayIds.add(relayId);
                const encoded = encodeStoredRelayOutbox({
                    event: current.event,
                    publishedRelayIds: [...publishedRelayIds],
                });
                try {
                    await transaction.set(key, encoded.slice());
                } finally {
                    zeroBytes(encoded);
                }
            } finally {
                destroySignedRelayEvent(current.event);
            }
        });
    }

    async #queueGlobalEvent(
        transaction: StoreTransaction,
        friendship: StoredFriendship,
        reason: GlobalFriendshipReason,
        createdAt: number,
        direction: FriendshipDirection = friendship.direction,
    ): Promise<void> {
        const peer = deserializeFriendshipIdentity(friendship.identity);
        let peerId: string;
        try {
            peerId = identityId(peer);
        } finally {
            destroyPublicIdentity(peer);
        }
        const id = friendship.eventVersion;
        const key = `${GLOBAL_OUTBOX_PREFIX}${id}`;
        const existing = await transaction.get(key);
        if (existing !== undefined) {
            zeroBytes(existing);
            return;
        }
        const retainedCount = await this.#readStoredCount(transaction, GLOBAL_OUTBOX_COUNT_KEY);
        if (retainedCount >= MAX_GLOBAL_OUTBOX_RECORDS) {
            // Any older retained event makes rig-connect refetch the same
            // authoritative snapshot, so dropping the newest notification is
            // safe while keeping an unavailable publisher off the write path.
            return;
        }
        const event: StoredGlobalFriendshipEvent = {
            createdAt,
            data: {
                direction,
                reason,
                state: friendship.state,
            },
            id,
            murmurPeerId: peerId,
            type: "murmur_friendship_changed",
            version: 1,
        };
        const encoded = encodeStoredGlobalFriendshipEvent(event);
        try {
            await transaction.set(key, encoded.slice());
            await this.#writeStoredCount(
                transaction,
                GLOBAL_OUTBOX_COUNT_KEY,
                increment(retainedCount),
            );
        } finally {
            zeroBytes(encoded);
        }
    }

    async #saveStoredFriendship(
        transaction: StoreTransaction,
        friendship: StoredFriendship,
    ): Promise<void> {
        const peer = deserializeFriendshipIdentity(friendship.identity);
        let key: string;
        try {
            key = relationshipKey(identityId(peer));
        } finally {
            destroyPublicIdentity(peer);
        }
        const existing = await transaction.get(key);
        if (existing === undefined) {
            const relationshipCount = await this.#readStoredCount(
                transaction,
                RELATIONSHIP_COUNT_KEY,
            );
            if (relationshipCount >= this.#maxRelationships) {
                throw new Error("Murmur friendship limit reached");
            }
            await this.#writeStoredCount(
                transaction,
                RELATIONSHIP_COUNT_KEY,
                increment(relationshipCount),
            );
        } else {
            zeroBytes(existing);
        }
        const encoded = encodeStoredFriendship(friendship);
        try {
            await transaction.set(key, encoded.slice());
        } finally {
            zeroBytes(encoded);
        }
    }

    async #readStoredFriendship(
        transaction: StoreTransaction,
        peerId: string,
    ): Promise<StoredFriendship | undefined> {
        const encoded = await transaction.get(relationshipKey(peerId));
        if (encoded === undefined) return undefined;
        try {
            return decodeStoredFriendship(encoded);
        } finally {
            zeroBytes(encoded);
        }
    }

    async #readAllStoredFriendships(): Promise<readonly StoredFriendship[]> {
        const records: StoredFriendship[] = [];
        let after: string | undefined;
        while (true) {
            const values = await this.#store.listPage(RELATIONSHIP_PREFIX, after, 100);
            try {
                for (const bytes of values.values()) records.push(decodeStoredFriendship(bytes));
                after = [...values.keys()].at(-1);
                if (values.size < 100) return records;
            } finally {
                for (const bytes of values.values()) zeroBytes(bytes);
            }
        }
    }

    async #quarantine(
        transaction: StoreTransaction,
        payload: Uint8Array,
        reason: string,
        createdAt: number,
    ): Promise<void> {
        const payloadDigest = hashBytes(payload);
        let id: string;
        try {
            id = stableDigest(
                `${reason}/${createdAt}/${payload.byteLength}/${encodeBase64Url(payloadDigest)}`,
            );
        } finally {
            zeroBytes(payloadDigest);
        }
        const encoded = encodeFriendshipQuarantine(payload.byteLength, createdAt, reason);
        try {
            await transaction.set(`${QUARANTINE_PREFIX}${id}`, encoded.slice());
        } finally {
            zeroBytes(encoded);
        }
        const retained = await transaction.list(QUARANTINE_PREFIX);
        try {
            const expired = [...retained.keys()]
                .sort()
                .slice(0, Math.max(0, retained.size - MAX_QUARANTINE_RECORDS));
            for (const key of expired) await transaction.delete(key);
        } finally {
            for (const bytes of retained.values()) zeroBytes(bytes);
        }
    }
}
