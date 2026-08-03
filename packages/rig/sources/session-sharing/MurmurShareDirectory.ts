import {
    createPrivateMessage,
    decodeBase64Url,
    decryptPrivateMessageFromContact,
    encodeBase64Url,
    encryptPrivateMessageForContact,
    identityId,
    identityInboxTopic,
    zeroBytes,
    type EncryptedPrivateMessage,
    type IdentityKeyPair,
    type IdentityPublicKeys,
    type ReceivedEvent,
    type StoreTransaction,
} from "@slopus/murmur";
import {
    createMlsKeyPackage,
    decodeMlsKeyPackage,
    deserializeMlsKeyPackageBundle,
    destroyMlsKeyPackageBundle,
    encodeMlsKeyPackage,
    mlsKeyPackageReference,
    serializeMlsKeyPackageBundle,
    verifyMlsKeyPackage,
    type MlsKeyPackage,
    type MlsKeyPackageBundle,
} from "@slopus/murmur/mls";
import {
    decodeSharedSessionInvitation,
    type SharedSessionInvitation,
} from "@slopus/murmur/sharedSession";

import { decodeMurmurIdentityToken } from "../murmur/impl/identityToken.js";
import type { MurmurRuntimeHandle, MurmurServiceContract } from "../murmur/types.js";
import type { MurmurFriendship } from "../protocol/MurmurProtocol.js";
import {
    decodeSharePrivateEnvelope,
    decodeSharePrivatePayload,
    decodeStoredShareInvitation,
    decodeStoredShareOfferedKeyPackage,
    decodeStoredShareOwnBundle,
    deserializeSharePublicIdentity,
    encodeInvitationForwardPayload,
    encodeKeyPackageOfferPayload,
    encodeKeyPackageRequestPayload,
    encodeSharePrivateEnvelope,
    encodeStoredShareInvitation,
    encodeStoredShareOfferedKeyPackage,
    encodeStoredShareOwnBundle,
    serializeSharePublicIdentity,
} from "./impl/shareCodec.js";
import type { SessionShareMurmurDirectory } from "./MurmurSessionShareTransport.js";

const STORE_PREFIX = "rig/murmur/share-directory/v1/";
const OWN_BUNDLE_PREFIX = `${STORE_PREFIX}own-bundle/`;
const OFFERED_PREFIX = `${STORE_PREFIX}offered/`;
const INVITATION_PREFIX = `${STORE_PREFIX}invitation/`;

/** Own generated one-use bundles retained globally while unconsumed. */
const MAX_OWN_BUNDLES = 32;
/** Friend-offered key packages retained per peer before the oldest is dropped. */
const MAX_OFFERED_PER_PEER = 8;
/** Received invitations retained globally while unresolved. */
const MAX_INVITATIONS = 256;

/**
 * Work a received envelope produced that must run after its store transaction
 * commits, because it either reaches the relay or observes committed state.
 */
type DirectoryEffect =
    | { readonly invitation: ReceivedShareInvitation; readonly type: "invited" }
    | { readonly murmurPeerId: string; readonly type: "offered" }
    | { readonly murmurPeerId: string; readonly type: "requested" };

/** One owner invitation this account has accepted delivery of. */
export interface ReceivedShareInvitation {
    readonly ownerPeerId: string;
    readonly shareId: string;
}

export interface MurmurShareDirectoryOptions {
    readonly murmur: Pick<MurmurServiceContract, "getFriends">;
    readonly now?: () => number;
    readonly runtime: () => MurmurRuntimeHandle | undefined;
}

function ownBundleKey(referenceId: string): string {
    return `${OWN_BUNDLE_PREFIX}${referenceId}`;
}

function offeredPeerPrefix(murmurPeerId: string): string {
    return `${OFFERED_PREFIX}${murmurPeerId}/`;
}

function offeredKey(murmurPeerId: string, referenceId: string): string {
    return `${offeredPeerPrefix(murmurPeerId)}${referenceId}`;
}

function invitationKey(shareId: string): string {
    return `${INVITATION_PREFIX}${shareId}`;
}

function destroyPublicIdentity(identity: IdentityPublicKeys): void {
    zeroBytes(identity.signingKey);
    zeroBytes(identity.encryptionKey);
}

function friendDisplayName(friend: MurmurFriendship): string {
    const profile = friend.profile;
    if (profile === undefined) return friend.peerId;
    const name = `${profile.firstName} ${profile.lastName}`.trim();
    return name.length === 0 ? friend.peerId : name;
}

async function evictOldest(
    transaction: StoreTransaction,
    prefix: string,
    maxEntries: number,
    timestampOf: (bytes: Uint8Array) => number,
): Promise<void> {
    const all = await transaction.list(prefix);
    if (all.size <= maxEntries) {
        for (const bytes of all.values()) zeroBytes(bytes);
        return;
    }
    const ordered = [...all.entries()]
        .map(([key, bytes]) => {
            const timestamp = timestampOf(bytes);
            zeroBytes(bytes);
            return { key, timestamp };
        })
        .sort(
            (left, right) => left.timestamp - right.timestamp || left.key.localeCompare(right.key),
        );
    const excess = ordered.length - maxEntries;
    for (let index = 0; index < excess; index += 1) await transaction.delete(ordered[index]!.key);
}

/**
 * Real `SessionShareMurmurDirectory`: transports one-use MLS KeyPackage offers
 * and owner invitations over Rig's existing encrypted Murmur friend channel.
 *
 * Murmur ships no key-package directory and no invitation inbox of its own, so
 * every friend proactively offers fresh one-use KeyPackages to the friends it
 * trusts, and an owner forwards each invitation the same way. Everything this
 * class keeps — unused own bundles, friends' offered KeyPackages, and received
 * invitations — lives in the Murmur store under its own bounded key prefix,
 * never in Rig's session database.
 */
export class MurmurShareDirectory implements SessionShareMurmurDirectory {
    readonly #invitationListeners = new Set<(invitation: ReceivedShareInvitation) => void>();
    readonly #keyPackageListeners = new Set<(murmurPeerId: string) => void>();
    readonly #murmur: Pick<MurmurServiceContract, "getFriends">;
    readonly #now: () => number;
    readonly #runtime: () => MurmurRuntimeHandle | undefined;

    constructor(options: MurmurShareDirectoryOptions) {
        this.#murmur = options.murmur;
        this.#now = options.now ?? Date.now;
        this.#runtime = options.runtime;
    }

    async identity(murmurPeerId: string): Promise<IdentityPublicKeys | undefined> {
        const friend = await this.#findFriend(murmurPeerId);
        if (friend === undefined) return undefined;
        try {
            return decodeMurmurIdentityToken(friend.token);
        } catch {
            return undefined;
        }
    }

    async displayName(murmurPeerId: string): Promise<string | undefined> {
        const friend = await this.#findFriend(murmurPeerId);
        return friend === undefined ? undefined : friendDisplayName(friend);
    }

    async keyPackage(murmurPeerId: string): Promise<MlsKeyPackage | undefined> {
        const friend = await this.#findFriend(murmurPeerId);
        if (friend === undefined) return undefined;
        const runtime = this.#requireRuntime();
        return runtime.store.transaction((transaction) =>
            this.#consumeOfferedKeyPackage(transaction, murmurPeerId),
        );
    }

    async deliver(invitation: SharedSessionInvitation): Promise<void> {
        const runtime = this.#requireRuntime();
        const peerId = identityId(invitation.recipient);
        const friend = await this.#findFriend(peerId);
        if (friend === undefined) {
            throw new Error(
                "Rig cannot deliver a shared-session invitation to an account that is not a Murmur friend.",
            );
        }
        await this.#sendPrivate(
            runtime,
            invitation.recipient,
            encodeInvitationForwardPayload(invitation.text),
        );
    }

    async acceptedInvitation(shareId: string): Promise<
        | {
              readonly bundle: MlsKeyPackageBundle;
              readonly invitation: string;
              readonly owner: IdentityPublicKeys;
          }
        | undefined
    > {
        const runtime = this.#requireRuntime();
        const storedBytes = await runtime.store.get(invitationKey(shareId));
        if (storedBytes === undefined) return undefined;
        const stored = decodeStoredShareInvitation(storedBytes);
        zeroBytes(storedBytes);
        const owner = deserializeSharePublicIdentity(stored.owner);
        let decoded: ReturnType<typeof decodeSharedSessionInvitation>;
        try {
            decoded = decodeSharedSessionInvitation(stored.invitationText, owner);
        } catch {
            destroyPublicIdentity(owner);
            return undefined;
        }
        if (decoded.shareId !== shareId) {
            destroyPublicIdentity(owner);
            zeroBytes(decoded.groupId);
            zeroBytes(decoded.welcome);
            zeroBytes(decoded.tree);
            zeroBytes(decoded.keyPackageReference);
            zeroBytes(decoded.commitFingerprint);
            return undefined;
        }
        const bundle = await this.#readOwnBundle(runtime.store, decoded.keyPackageReference);
        zeroBytes(decoded.groupId);
        zeroBytes(decoded.welcome);
        zeroBytes(decoded.tree);
        zeroBytes(decoded.keyPackageReference);
        zeroBytes(decoded.commitFingerprint);
        if (bundle === undefined) {
            destroyPublicIdentity(owner);
            return undefined;
        }
        return { bundle, invitation: stored.invitationText, owner };
    }

    /** Generate a fresh one-use bundle and offer its public half to one friend. */
    async publishKeyPackageOffer(murmurPeerId: string): Promise<void> {
        const friend = await this.#findFriend(murmurPeerId);
        if (friend === undefined) {
            throw new Error(
                "Rig cannot offer a key package to an account that is not a Murmur friend.",
            );
        }
        const runtime = this.#requireRuntime();
        const identity = decodeMurmurIdentityToken(friend.token);
        try {
            const bundle = createMlsKeyPackage(runtime.identity);
            try {
                await runtime.store.transaction((transaction) =>
                    this.#saveOwnBundle(transaction, bundle, this.#now()),
                );
                const keyPackageBytes = encodeMlsKeyPackage(bundle.keyPackage);
                try {
                    await this.#sendPrivate(
                        runtime,
                        identity,
                        encodeKeyPackageOfferPayload(keyPackageBytes, this.#now()),
                    );
                } finally {
                    zeroBytes(keyPackageBytes);
                }
            } finally {
                destroyMlsKeyPackageBundle(bundle);
            }
        } finally {
            destroyPublicIdentity(identity);
        }
    }

    /**
     * Offer one fresh key package to every confirmed friend.
     *
     * Called whenever the Murmur service starts, so a friend can invite this
     * account into a shared session without a prior round trip.
     */
    async publishKeyPackageOffers(): Promise<void> {
        const { friendships } = await this.#murmur.getFriends();
        for (const friendship of friendships) {
            if (friendship.state !== "friends") continue;
            try {
                await this.publishKeyPackageOffer(friendship.peerId);
            } catch {
                // One unreachable friend must not stop the rest; the owner's
                // key-package request covers whatever this pass missed.
            }
        }
    }

    /** Ask one friend for a fresh key package after running out of theirs. */
    async requestKeyPackage(murmurPeerId: string): Promise<void> {
        const friend = await this.#findFriend(murmurPeerId);
        if (friend === undefined) return;
        const runtime = this.#requireRuntime();
        const identity = decodeMurmurIdentityToken(friend.token);
        try {
            await this.#sendPrivate(runtime, identity, encodeKeyPackageRequestPayload(this.#now()));
        } finally {
            destroyPublicIdentity(identity);
        }
    }

    /** Observe a friend's key package arriving, which can unblock a deferred invitation. */
    onKeyPackageOffered(listener: (murmurPeerId: string) => void): () => void {
        this.#keyPackageListeners.add(listener);
        return () => this.#keyPackageListeners.delete(listener);
    }

    /** Observe an owner's invitation arriving, which is how this account joins a share. */
    onInvitation(listener: (invitation: ReceivedShareInvitation) => void): () => void {
        this.#invitationListeners.add(listener);
        return () => this.#invitationListeners.delete(listener);
    }

    /** Handle one received event; returns whether it belonged to this directory. */
    async handleReceivedEvent(received: ReceivedEvent): Promise<boolean> {
        const runtime = this.#runtime();
        if (runtime === undefined) return false;
        if (received.event.topic !== identityInboxTopic(runtime.identity)) return false;
        let encrypted: EncryptedPrivateMessage;
        try {
            encrypted = decodeSharePrivateEnvelope(received.event.payload);
        } catch {
            return false;
        }
        // Friendship lives behind the Murmur service's own serialized store access, so it
        // is resolved before the transaction opens rather than nested inside one.
        const { friendships } = await this.#murmur.getFriends();
        const friends = new Set(
            friendships
                .filter((friendship) => friendship.state === "friends")
                .map((friendship) => friendship.peerId),
        );
        const effects: DirectoryEffect[] = [];
        await runtime.store.transaction(async (transaction) => {
            const effect = await this.#processEnvelope(
                transaction,
                runtime.identity,
                encrypted,
                friends,
            );
            if (effect !== undefined) effects.push(effect);
            await received.advanceCursor(transaction);
        });
        // Publishing and joining are deliberately outside the store transaction: both
        // reach the relay, and neither may keep the cursor write open.
        for (const effect of effects) await this.#applyEffect(effect);
        return true;
    }

    /** Invitations still held for shares this account has not resolved yet. */
    async pendingInvitations(): Promise<readonly ReceivedShareInvitation[]> {
        const runtime = this.#runtime();
        if (runtime === undefined) return [];
        const stored = await runtime.store.list(INVITATION_PREFIX);
        const invitations: ReceivedShareInvitation[] = [];
        for (const [key, bytes] of stored) {
            const record = decodeStoredShareInvitation(bytes);
            zeroBytes(bytes);
            const owner = deserializeSharePublicIdentity(record.owner);
            invitations.push({
                ownerPeerId: identityId(owner),
                shareId: key.slice(INVITATION_PREFIX.length),
            });
            destroyPublicIdentity(owner);
        }
        return invitations;
    }

    async #applyEffect(effect: DirectoryEffect): Promise<void> {
        if (effect.type === "offered") {
            for (const listener of this.#keyPackageListeners) listener(effect.murmurPeerId);
            return;
        }
        if (effect.type === "invited") {
            for (const listener of this.#invitationListeners) listener(effect.invitation);
            return;
        }
        try {
            await this.publishKeyPackageOffer(effect.murmurPeerId);
        } catch {
            // A friend that cannot be reached right now simply asks again later.
        }
    }

    #requireRuntime(): MurmurRuntimeHandle {
        const runtime = this.#runtime();
        if (runtime === undefined) {
            throw new Error("Session sharing needs the Murmur service to be running.");
        }
        return runtime;
    }

    async #findFriend(murmurPeerId: string): Promise<MurmurFriendship | undefined> {
        const { friendships } = await this.#murmur.getFriends();
        return friendships.find(
            (friendship) => friendship.peerId === murmurPeerId && friendship.state === "friends",
        );
    }

    async #sendPrivate(
        runtime: MurmurRuntimeHandle,
        recipient: IdentityPublicKeys,
        text: string,
    ): Promise<void> {
        const message = createPrivateMessage(text);
        const encrypted = encryptPrivateMessageForContact(runtime.identity, recipient, message);
        const envelope = encodeSharePrivateEnvelope(encrypted);
        try {
            await runtime.client.publishUnlinkable(identityInboxTopic(recipient), envelope);
        } finally {
            zeroBytes(envelope);
        }
    }

    async #processEnvelope(
        transaction: StoreTransaction,
        ownIdentity: IdentityKeyPair,
        encrypted: EncryptedPrivateMessage,
        friends: ReadonlySet<string>,
    ): Promise<DirectoryEffect | undefined> {
        let opened;
        try {
            opened = decryptPrivateMessageFromContact(ownIdentity, encrypted);
        } catch {
            return undefined;
        }
        try {
            const senderId = identityId(opened.identity);
            // The identity inbox is public; only a confirmed friend's payload is trusted.
            if (!friends.has(senderId)) return undefined;
            let payload;
            try {
                payload = decodeSharePrivatePayload(opened.message.text);
            } catch {
                return undefined;
            }
            if (payload.kind === "rig.murmur.share-keypackage-request.v1") {
                return { murmurPeerId: senderId, type: "requested" };
            }
            if (payload.kind === "rig.murmur.share-keypackage.v1") {
                const stored = await this.#storeOfferedKeyPackage(
                    transaction,
                    senderId,
                    payload.keyPackage,
                );
                return stored ? { murmurPeerId: senderId, type: "offered" } : undefined;
            }
            const shareId = await this.#storeInvitation(
                transaction,
                opened.identity,
                payload.invitationText,
            );
            return shareId === undefined
                ? undefined
                : { invitation: { ownerPeerId: senderId, shareId }, type: "invited" };
        } finally {
            destroyPublicIdentity(opened.identity);
            for (const attachment of opened.message.attachments) {
                zeroBytes(attachment.key);
                zeroBytes(attachment.nonce);
            }
        }
    }

    async #storeOfferedKeyPackage(
        transaction: StoreTransaction,
        senderId: string,
        keyPackageBase64: string,
    ): Promise<boolean> {
        const encoded = decodeBase64Url(keyPackageBase64);
        let keyPackage: MlsKeyPackage;
        try {
            keyPackage = decodeMlsKeyPackage(encoded);
        } catch {
            zeroBytes(encoded);
            return false;
        }
        if (!verifyMlsKeyPackage(keyPackage, Math.floor(this.#now() / 1000))) {
            zeroBytes(encoded);
            return false;
        }
        const referenceId = encodeBase64Url(mlsKeyPackageReference(keyPackage));
        zeroBytes(encoded);
        const record = encodeStoredShareOfferedKeyPackage({
            keyPackage: keyPackageBase64,
            offeredAt: this.#now(),
            version: 1,
        });
        try {
            await transaction.set(offeredKey(senderId, referenceId), record.slice());
        } finally {
            zeroBytes(record);
        }
        await evictOldest(
            transaction,
            offeredPeerPrefix(senderId),
            MAX_OFFERED_PER_PEER,
            (bytes) => decodeStoredShareOfferedKeyPackage(bytes).offeredAt,
        );
        return true;
    }

    async #storeInvitation(
        transaction: StoreTransaction,
        ownerIdentity: IdentityPublicKeys,
        invitationText: string,
    ): Promise<string | undefined> {
        let decoded: ReturnType<typeof decodeSharedSessionInvitation>;
        try {
            decoded = decodeSharedSessionInvitation(invitationText, ownerIdentity);
        } catch {
            return undefined;
        }
        zeroBytes(decoded.groupId);
        zeroBytes(decoded.welcome);
        zeroBytes(decoded.tree);
        zeroBytes(decoded.keyPackageReference);
        zeroBytes(decoded.commitFingerprint);
        const record = encodeStoredShareInvitation({
            invitationText,
            owner: serializeSharePublicIdentity(ownerIdentity),
            receivedAt: this.#now(),
            version: 1,
        });
        try {
            await transaction.set(invitationKey(decoded.shareId), record.slice());
        } finally {
            zeroBytes(record);
        }
        await evictOldest(
            transaction,
            INVITATION_PREFIX,
            MAX_INVITATIONS,
            (bytes) => decodeStoredShareInvitation(bytes).receivedAt,
        );
        return decoded.shareId;
    }

    async #consumeOfferedKeyPackage(
        transaction: StoreTransaction,
        murmurPeerId: string,
    ): Promise<MlsKeyPackage | undefined> {
        const all = await transaction.list(offeredPeerPrefix(murmurPeerId));
        const entries = [...all.entries()]
            .map(([key, bytes]) => {
                const record = decodeStoredShareOfferedKeyPackage(bytes);
                zeroBytes(bytes);
                return { key, keyPackage: record.keyPackage, offeredAt: record.offeredAt };
            })
            .sort(
                (left, right) =>
                    left.offeredAt - right.offeredAt || left.key.localeCompare(right.key),
            );
        const nowSeconds = Math.floor(this.#now() / 1000);
        for (const entry of entries) {
            await transaction.delete(entry.key);
            const encoded = decodeBase64Url(entry.keyPackage);
            let keyPackage: MlsKeyPackage;
            try {
                keyPackage = decodeMlsKeyPackage(encoded);
            } catch {
                continue;
            } finally {
                zeroBytes(encoded);
            }
            if (!verifyMlsKeyPackage(keyPackage, nowSeconds)) continue;
            return keyPackage;
        }
        return undefined;
    }

    async #saveOwnBundle(
        transaction: StoreTransaction,
        bundle: MlsKeyPackageBundle,
        createdAt: number,
    ): Promise<void> {
        const referenceId = encodeBase64Url(mlsKeyPackageReference(bundle.keyPackage));
        const serialized = serializeMlsKeyPackageBundle(bundle);
        try {
            const encoded = encodeStoredShareOwnBundle({
                bundle: encodeBase64Url(serialized),
                createdAt,
                version: 1,
            });
            try {
                await transaction.set(ownBundleKey(referenceId), encoded.slice());
            } finally {
                zeroBytes(encoded);
            }
        } finally {
            zeroBytes(serialized);
        }
        await evictOldest(
            transaction,
            OWN_BUNDLE_PREFIX,
            MAX_OWN_BUNDLES,
            (bytes) => decodeStoredShareOwnBundle(bytes).createdAt,
        );
    }

    async #readOwnBundle(
        store: Pick<StoreTransaction, "get">,
        referenceBytes: Uint8Array,
    ): Promise<MlsKeyPackageBundle | undefined> {
        const referenceId = encodeBase64Url(referenceBytes);
        const bytes = await store.get(ownBundleKey(referenceId));
        if (bytes === undefined) return undefined;
        const record = decodeStoredShareOwnBundle(bytes);
        zeroBytes(bytes);
        const serialized = decodeBase64Url(record.bundle);
        try {
            return deserializeMlsKeyPackageBundle(serialized);
        } catch {
            return undefined;
        } finally {
            zeroBytes(serialized);
        }
    }
}
