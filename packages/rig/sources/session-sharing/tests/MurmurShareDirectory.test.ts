import {
    createPrivateMessage,
    encryptPrivateMessageForContact,
    generateIdentityKeyPair,
    identityId,
    identityInboxTopic,
    MemoryMurmurStore,
    MurmurClient,
    type IdentityKeyPair,
    type MurmurStore,
} from "@slopus/murmur";
import { createMlsKeyPackage, encodeMlsKeyPackage, verifyMlsKeyPackage } from "@slopus/murmur/mls";
import {
    SharedSessionMember,
    SharedSessionOwner,
    type SessionEntrySource,
    type SharedSessionCallbacks,
} from "@slopus/murmur/sharedSession";
import { describe, expect, it } from "vitest";

import { encodeMurmurIdentityToken } from "../../murmur/impl/identityToken.js";
import { InMemoryMurmurRelay } from "../../murmur/InMemoryMurmurRelay.js";
import type { MurmurRuntimeHandle, MurmurServiceContract } from "../../murmur/types.js";
import type { MurmurFriendship } from "../../protocol/MurmurProtocol.js";
import { encodeKeyPackageOfferPayload, encodeSharePrivateEnvelope } from "../impl/shareCodec.js";
import { MurmurShareDirectory } from "../MurmurShareDirectory.js";

interface Peer {
    readonly client: MurmurClient;
    readonly identity: IdentityKeyPair;
    readonly peerId: string;
    readonly store: MurmurStore;
}

async function createPeer(relay: InMemoryMurmurRelay): Promise<Peer> {
    const identity = generateIdentityKeyPair();
    const store = new MemoryMurmurStore();
    const client = new MurmurClient({ identity, store, transports: [relay.transport("relay")] });
    await client.subscribe(identityInboxTopic(identity));
    return { client, identity, peerId: identityId(identity), store };
}

function runtimeOf(peer: Peer): MurmurRuntimeHandle {
    return { client: peer.client, identity: peer.identity, store: peer.store };
}

function friendshipRecord(peer: Peer, overrides: Partial<MurmurFriendship> = {}): MurmurFriendship {
    return {
        autoAcceptEligible: false,
        direction: "mutual",
        firstSeenAt: 1_700_000_000_000,
        history: { accepted: 1, autoAccepted: 0, received: 0, rejected: 0, sent: 1 },
        peerId: peer.peerId,
        profile: { firstName: "Ada", lastName: "Friend" },
        state: "friends",
        token: encodeMurmurIdentityToken(peer.identity),
        updatedAt: 1_700_000_000_000,
        version: "friendship-1",
        ...overrides,
    };
}

function fakeMurmur(
    friendships: readonly MurmurFriendship[],
): Pick<MurmurServiceContract, "getFriends"> {
    return {
        getFriends: async () => ({
            contacts: [],
            friendships: [...friendships],
            service: { relayUrls: [], status: "running" },
            stats: {
                acceptedRequests: 0,
                autoAcceptedRequests: 0,
                contacts: 0,
                incomingPending: 0,
                outgoingPending: 0,
                rejectedRequests: 0,
            },
        }),
    };
}

function directoryFor(peer: Peer, friendships: readonly MurmurFriendship[]): MurmurShareDirectory {
    return new MurmurShareDirectory({
        murmur: fakeMurmur(friendships),
        runtime: () => runtimeOf(peer),
    });
}

/** Drains every event currently queued for one peer into its directory. */
async function pump(peer: Peer, directory: MurmurShareDirectory): Promise<void> {
    for (let round = 0; round < 10; round += 1) {
        const result = await peer.client.sync(0);
        if (result.status === "reset") continue;
        if (result.events.length === 0) return;
        for (const received of result.events) await directory.handleReceivedEvent(received);
    }
}

function noopCallbacks(): SharedSessionCallbacks {
    return {
        persistEntry: async () => {},
        persistPost: async () => {},
        persistState: async () => {},
        terminate: async () => {},
    };
}

function emptyEntrySource(): SessionEntrySource {
    return { readPage: async () => ({ done: true, entries: [] }) };
}

describe("MurmurShareDirectory", () => {
    it("round-trips a friend's offered key package through encode, decode, and verification", async () => {
        const relay = new InMemoryMurmurRelay();
        const owner = await createPeer(relay);
        const friend = await createPeer(relay);
        const ownerDirectory = directoryFor(owner, [friendshipRecord(friend)]);
        const friendDirectory = directoryFor(friend, [friendshipRecord(owner)]);

        await friendDirectory.publishKeyPackageOffer(owner.peerId);
        await pump(owner, ownerDirectory);

        const keyPackage = await ownerDirectory.keyPackage(friend.peerId);
        expect(keyPackage).toBeDefined();
        expect(verifyMlsKeyPackage(keyPackage!)).toBe(true);
    });

    it("answers a friend's key package request with a fresh offer", async () => {
        const relay = new InMemoryMurmurRelay();
        const owner = await createPeer(relay);
        const friend = await createPeer(relay);
        const ownerDirectory = directoryFor(owner, [friendshipRecord(friend)]);
        const friendDirectory = directoryFor(friend, [friendshipRecord(owner)]);
        const offered: string[] = [];
        ownerDirectory.onKeyPackageOffered((peerId) => offered.push(peerId));

        // The owner holds nothing to invite this friend with, so it asks for one.
        expect(await ownerDirectory.keyPackage(friend.peerId)).toBeUndefined();
        await ownerDirectory.requestKeyPackage(friend.peerId);
        await pump(friend, friendDirectory);
        await pump(owner, ownerDirectory);

        expect(offered).toEqual([friend.peerId]);
        expect(await ownerDirectory.keyPackage(friend.peerId)).toBeDefined();
    });

    it("rejects a corrupted or unverifiable key package", async () => {
        const relay = new InMemoryMurmurRelay();
        const owner = await createPeer(relay);
        const friend = await createPeer(relay);
        const ownerDirectory = directoryFor(owner, [friendshipRecord(friend)]);

        const bundle = createMlsKeyPackage(friend.identity);
        const bytes = encodeMlsKeyPackage(bundle.keyPackage);
        bytes[bytes.length - 1] = (bytes[bytes.length - 1]! ^ 0xff) & 0xff;
        const text = encodeKeyPackageOfferPayload(bytes, Date.now());
        const message = createPrivateMessage(text);
        const encrypted = encryptPrivateMessageForContact(friend.identity, owner.identity, message);
        const envelope = encodeSharePrivateEnvelope(encrypted);
        await friend.client.publishUnlinkable(identityInboxTopic(owner.identity), envelope);

        await pump(owner, ownerDirectory);

        const keyPackage = await ownerDirectory.keyPackage(friend.peerId);
        expect(keyPackage).toBeUndefined();
    });

    it("consumes an offered key package only once", async () => {
        const relay = new InMemoryMurmurRelay();
        const owner = await createPeer(relay);
        const friend = await createPeer(relay);
        const ownerDirectory = directoryFor(owner, [friendshipRecord(friend)]);
        const friendDirectory = directoryFor(friend, [friendshipRecord(owner)]);

        await friendDirectory.publishKeyPackageOffer(owner.peerId);
        await pump(owner, ownerDirectory);

        const first = await ownerDirectory.keyPackage(friend.peerId);
        const second = await ownerDirectory.keyPackage(friend.peerId);
        expect(first).toBeDefined();
        expect(second).toBeUndefined();
    });

    it("resolves a stranger's identity, display name, and key package to undefined", async () => {
        const relay = new InMemoryMurmurRelay();
        const owner = await createPeer(relay);
        const stranger = await createPeer(relay);
        const ownerDirectory = directoryFor(owner, []);

        expect(await ownerDirectory.identity(stranger.peerId)).toBeUndefined();
        expect(await ownerDirectory.displayName(stranger.peerId)).toBeUndefined();
        expect(await ownerDirectory.keyPackage(stranger.peerId)).toBeUndefined();
        await expect(
            ownerDirectory.deliver({
                deliveryId: "delivery-1",
                recipient: stranger.identity,
                sentAt: Date.now(),
                text: "not-a-real-invitation",
            }),
        ).rejects.toThrow();
    });

    it("stores a delivered invitation and returns it with its matching bundle", async () => {
        const relay = new InMemoryMurmurRelay();
        const owner = await createPeer(relay);
        const member = await createPeer(relay);
        const ownerDirectory = directoryFor(owner, [friendshipRecord(member)]);
        const memberDirectory = directoryFor(member, [friendshipRecord(owner)]);

        await memberDirectory.publishKeyPackageOffer(owner.peerId);
        await pump(owner, ownerDirectory);

        const keyPackage = await ownerDirectory.keyPackage(member.peerId);
        expect(keyPackage).toBeDefined();

        const ownerSession = await SharedSessionOwner.create("share-1", {
            callbacks: noopCallbacks(),
            client: owner.client,
            entrySource: emptyEntrySource(),
            identity: owner.identity,
            invitationDelivery: { deliver: (invitation) => ownerDirectory.deliver(invitation) },
            store: owner.store,
        });
        await ownerSession.inviteMany([{ identity: member.identity, keyPackage: keyPackage! }]);

        await pump(member, memberDirectory);

        const accepted = await memberDirectory.acceptedInvitation("share-1");
        expect(accepted).toBeDefined();
        expect(identityId(accepted!.owner)).toBe(owner.peerId);
        expect(accepted!.invitation.length).toBeGreaterThan(0);

        const memberSession = await SharedSessionMember.join({
            callbacks: noopCallbacks(),
            client: member.client,
            expectedOwner: accepted!.owner,
            identity: member.identity,
            invitation: accepted!.invitation,
            keyPackageBundle: accepted!.bundle,
            store: member.store,
        });
        expect(memberSession.shareId).toBe("share-1");

        ownerSession.destroy();
        memberSession.destroy();
    });

    it("bounds retained own bundles and offered key packages per peer", async () => {
        const relay = new InMemoryMurmurRelay();
        const owner = await createPeer(relay);
        const friend = await createPeer(relay);
        const ownerDirectory = directoryFor(owner, [friendshipRecord(friend)]);
        const friendDirectory = directoryFor(friend, [friendshipRecord(owner)]);

        for (let index = 0; index < 40; index += 1) {
            await friendDirectory.publishKeyPackageOffer(owner.peerId);
        }
        // Own bundles are retained per peer, bounded by what that peer keeps of
        // our offered public halves, so both stores settle at the same cap.
        const ownBundleKeys = await friend.store.list(
            `rig/murmur/share-directory/v1/own-bundle/${owner.peerId}/`,
        );
        expect(ownBundleKeys.size).toBeLessThanOrEqual(8);

        await pump(owner, ownerDirectory);
        const offeredKeys = await owner.store.list(
            `rig/murmur/share-directory/v1/offered/${friend.peerId}/`,
        );
        expect(offeredKeys.size).toBeLessThanOrEqual(8);
        expect(offeredKeys.size).toBeGreaterThan(0);
    });

    it("keeps the newest offer joinable after the per-peer cap is exercised", async () => {
        const relay = new InMemoryMurmurRelay();
        const owner = await createPeer(relay);
        const member = await createPeer(relay);
        const ownerDirectory = directoryFor(owner, [friendshipRecord(member)]);
        const memberDirectory = directoryFor(member, [friendshipRecord(owner)]);

        // Offer far more than either side retains, so the member's own-bundle
        // store and the owner's offered store both evict oldest-first down to the
        // cap. The owner then consumes the newest offer it still holds.
        for (let index = 0; index < 12; index += 1) {
            await memberDirectory.publishKeyPackageOffer(owner.peerId);
        }
        await pump(owner, ownerDirectory);
        const ownBundleKeys = await member.store.list(
            `rig/murmur/share-directory/v1/own-bundle/${owner.peerId}/`,
        );
        expect(ownBundleKeys.size).toBe(8);

        const keyPackage = await ownerDirectory.keyPackage(member.peerId);
        expect(keyPackage).toBeDefined();

        const ownerSession = await SharedSessionOwner.create("share-cap", {
            callbacks: noopCallbacks(),
            client: owner.client,
            entrySource: emptyEntrySource(),
            identity: owner.identity,
            invitationDelivery: { deliver: (invitation) => ownerDirectory.deliver(invitation) },
            store: owner.store,
        });
        await ownerSession.inviteMany([{ identity: member.identity, keyPackage: keyPackage! }]);
        await pump(member, memberDirectory);

        const accepted = await memberDirectory.acceptedInvitation("share-cap");
        expect(accepted).toBeDefined();
        const memberSession = await SharedSessionMember.join({
            callbacks: noopCallbacks(),
            client: member.client,
            expectedOwner: accepted!.owner,
            identity: member.identity,
            invitation: accepted!.invitation,
            keyPackageBundle: accepted!.bundle,
            store: member.store,
        });
        expect(memberSession.shareId).toBe("share-cap");

        // The one-use bundle is deleted as it is read, so a second attempt for the
        // same share finds no private material and returns nothing.
        expect(await memberDirectory.acceptedInvitation("share-cap")).toBeUndefined();

        ownerSession.destroy();
        memberSession.destroy();
    });

    it("keeps two friends' invitations for the same shareId from colliding", async () => {
        const relay = new InMemoryMurmurRelay();
        const member = await createPeer(relay);
        const ownerA = await createPeer(relay);
        const ownerB = await createPeer(relay);
        const memberDirectory = directoryFor(member, [
            friendshipRecord(ownerA),
            friendshipRecord(ownerB),
        ]);
        const ownerADirectory = directoryFor(ownerA, [friendshipRecord(member)]);
        const ownerBDirectory = directoryFor(ownerB, [friendshipRecord(member)]);

        await memberDirectory.publishKeyPackageOffer(ownerA.peerId);
        await memberDirectory.publishKeyPackageOffer(ownerB.peerId);
        await pump(ownerA, ownerADirectory);
        await pump(ownerB, ownerBDirectory);

        const inviteWithSharedId = async (
            owner: Peer,
            directory: MurmurShareDirectory,
        ): Promise<SharedSessionOwner> => {
            const keyPackage = await directory.keyPackage(member.peerId);
            expect(keyPackage).toBeDefined();
            const session = await SharedSessionOwner.create("shared-id", {
                callbacks: noopCallbacks(),
                client: owner.client,
                entrySource: emptyEntrySource(),
                identity: owner.identity,
                invitationDelivery: { deliver: (invitation) => directory.deliver(invitation) },
                store: owner.store,
            });
            await session.inviteMany([{ identity: member.identity, keyPackage: keyPackage! }]);
            return session;
        };

        // Both friends deliberately invite the member to the same attacker-chosen
        // shareId; neither invitation may overwrite the other.
        const sessionA = await inviteWithSharedId(ownerA, ownerADirectory);
        const sessionB = await inviteWithSharedId(ownerB, ownerBDirectory);
        await pump(member, memberDirectory);

        const pending = await memberDirectory.pendingInvitations();
        expect(pending).toEqual(
            expect.arrayContaining([
                { ownerPeerId: ownerA.peerId, shareId: "shared-id" },
                { ownerPeerId: ownerB.peerId, shareId: "shared-id" },
            ]),
        );
        expect(pending).toHaveLength(2);

        sessionA.destroy();
        sessionB.destroy();
    });
});
