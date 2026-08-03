import {
    MemoryMurmurStore,
    MurmurClient,
    generateIdentityKeyPair,
    identityId,
    type IdentityKeyPair,
    type MurmurStore,
} from "@slopus/murmur";
import { createMlsKeyPackage, type MlsKeyPackageBundle } from "@slopus/murmur/mls";
import type { SessionEntrySource, SharedSessionInvitation } from "@slopus/murmur/sharedSession";
import { describe, expect, it } from "vitest";

import { InMemoryMurmurRelay } from "../../murmur/InMemoryMurmurRelay.js";
import type { MurmurRuntimeHandle } from "../../murmur/types.js";
import {
    MurmurSessionShareTransport,
    type SessionShareMurmurDirectory,
} from "../MurmurSessionShareTransport.js";
import { projectSessionShareEntry } from "../projectSessionShareEntry.js";
import { SessionShareUnauthorizedPostError } from "../SessionShareService.js";
import type {
    SessionShareOpaqueEntry,
    SessionShareTransportGrant,
    SessionShareTransportMemberEvent,
    SessionShareTransportOwnerEvent,
} from "../SessionShareTransport.js";

interface Peer {
    readonly client: MurmurClient;
    readonly identity: IdentityKeyPair;
    readonly peerId: string;
    readonly store: MurmurStore;
}

function createPeer(relay: InMemoryMurmurRelay): Peer {
    const identity = generateIdentityKeyPair();
    const store = new MemoryMurmurStore();
    return {
        client: new MurmurClient({ identity, store, transports: [relay.transport("relay")] }),
        identity,
        peerId: identityId(identity),
        store,
    };
}

function runtimeOf(peer: Peer): () => MurmurRuntimeHandle {
    return () => ({ client: peer.client, identity: peer.identity, store: peer.store });
}

function entry(shareId: string, sequence: number, text: string): SessionShareOpaqueEntry {
    return projectSessionShareEntry({
        createdAt: 1_700_000_000_000 + sequence,
        shareEventId: `0199f000-0000-7000-8000-00000000000${String(sequence)}`,
        shareId,
        shareSequence: sequence,
        source: {
            event: {
                createdAt: 1_700_000_000_000 + sequence,
                data: {
                    message: {
                        blocks: [{ text, type: "text" as const }],
                        id: `notice-${String(sequence)}`,
                        role: "system" as const,
                    },
                },
                id: `event-${String(sequence)}`,
                sessionId: "session-1",
                type: "system_notice",
            },
            kind: "event",
        },
    })!;
}

function entrySourceOver(entries: readonly SessionShareOpaqueEntry[]): SessionEntrySource {
    return {
        readPage: async ({ afterSequence, maximumBytes, maximumEntries }) => {
            const remaining = entries.filter((item) => item.shareSequence > afterSequence);
            const page = [];
            let bytes = 0;
            for (const item of remaining) {
                const size = Buffer.byteLength(item.canonicalJson, "utf8");
                if (
                    page.length > 0 &&
                    (page.length >= maximumEntries || bytes + size > maximumBytes)
                ) {
                    break;
                }
                page.push({
                    payload: JSON.parse(item.canonicalJson) as never,
                    shareEventId: item.shareEventId,
                    shareSequence: item.shareSequence,
                    timestamp: item.createdAt,
                });
                bytes += size;
            }
            return { done: page.length === remaining.length, entries: page };
        },
    };
}

async function pump(peer: Peer, transport: MurmurSessionShareTransport): Promise<void> {
    for (let round = 0; round < 20; round += 1) {
        const result = await peer.client.sync(0);
        if (result.status === "reset") continue;
        if (result.events.length === 0) return;
        for (const received of result.events) {
            const outcome = await transport.handleReceivedEvent(received);
            if (outcome === "retained") return;
            if (outcome === "applied") continue;
            await peer.store.transaction(async (transaction) => {
                await received.advanceCursor(transaction);
            });
        }
    }
}

/** A directory whose absence is the point: these cases must not consult it. */
function unusedDirectory(): SessionShareMurmurDirectory {
    const fail = (): never => {
        throw new Error("This case must not consult the Murmur directory.");
    };
    return {
        acceptedInvitation: async () => fail(),
        deliver: async () => fail(),
        displayName: async () => fail(),
        identity: async () => fail(),
        keyPackage: async () => fail(),
        requestKeyPackage: async () => fail(),
    };
}

describe("the Murmur session-share transport", () => {
    it("replicates a shared session to a friend and carries their reply back", async () => {
        const relay = new InMemoryMurmurRelay();
        const owner = createPeer(relay);
        const friend = createPeer(relay);
        const shareId = "share-alpha";
        // Filled after the owner exists, the way the real service does it: a share is
        // created first and its transcript only reaches the log once published.
        const appended: SessionShareOpaqueEntry[] = [];
        const invitations: SharedSessionInvitation[] = [];
        const friendBundle: MlsKeyPackageBundle = createMlsKeyPackage(friend.identity);

        const ownerDirectory: SessionShareMurmurDirectory = {
            acceptedInvitation: async () => undefined,
            deliver: async (invitation) => {
                invitations.push(invitation);
            },
            displayName: async () => "Dana",
            identity: async () => friend.identity,
            keyPackage: async () => friendBundle.keyPackage,
            requestKeyPackage: async () => undefined,
        };
        const friendDirectory: SessionShareMurmurDirectory = {
            acceptedInvitation: async () => ({
                bundle: friendBundle,
                invitation: invitations[0]!.text,
                owner: owner.identity,
            }),
            deliver: async () => undefined,
            displayName: async () => undefined,
            identity: async () => owner.identity,
            keyPackage: async () => undefined,
            requestKeyPackage: async () => undefined,
        };

        const ownerTransport = new MurmurSessionShareTransport({
            directory: ownerDirectory,
            entrySource: () => entrySourceOver(appended),
            runtime: runtimeOf(owner),
        });
        const friendTransport = new MurmurSessionShareTransport({
            directory: friendDirectory,
            entrySource: () => entrySourceOver([]),
            runtime: runtimeOf(friend),
        });

        const ownerEvents: SessionShareTransportOwnerEvent[] = [];
        const memberEvents: SessionShareTransportMemberEvent[] = [];
        const grant: SessionShareTransportGrant = {
            grantEpoch: 1,
            murmurPeerId: friend.peerId,
            shareId,
            shareMemberId: "member-1",
        };

        let rejectPosts = false;
        ownerTransport.handleOwnerEvents(shareId, (event) => {
            if (rejectPosts && event.type === "member_posted") {
                throw new SessionShareUnauthorizedPostError("The grant no longer accepts posts.");
            }
            ownerEvents.push(event);
        });
        friendTransport.handleMemberEvents(grant, (event) => {
            memberEvents.push(event);
        });

        await ownerTransport.createOwner({ ownerPeerId: owner.peerId, shareId });
        appended.push(
            entry(shareId, 1, "Looking at the failing test."),
            entry(shareId, 2, "Found the cause."),
        );
        await ownerTransport.appendOwnerEntries(shareId, appended);
        await ownerTransport.inviteMany([grant]);

        expect(await ownerTransport.loadOwner(shareId)).toEqual({
            ownerPeerId: owner.peerId,
            shareId,
        });

        await friendTransport.joinMember(grant);
        for (let round = 0; round < 8; round += 1) {
            await ownerTransport.retry(shareId);
            await pump(owner, ownerTransport);
            await friendTransport.retry(shareId);
            await pump(friend, friendTransport);
            if (replicated(memberEvents).length >= 2) break;
        }

        expect(replicated(memberEvents).map((item) => item.shareSequence)).toEqual([1, 2]);
        expect(replicated(memberEvents).map((item) => item.canonicalJson)).toEqual(
            appended.map((item) => item.canonicalJson),
        );
        expect(replicated(memberEvents).map((item) => item.contentHash)).toEqual(
            appended.map((item) => item.contentHash),
        );

        await friendTransport.postMember({
            clientMessageId: "post-1",
            displayName: "Dana",
            grant,
            text: "Try clearing the cache first.",
        });
        await pump(owner, ownerTransport);

        const posted = ownerEvents.filter((event) => event.type === "member_posted");
        expect(posted).toHaveLength(1);
        expect(posted[0]).toMatchObject({
            post: {
                clientMessageId: "post-1",
                // The transport labels a post with the peer it authenticated; the owner
                // replaces that with the name it registered for the member.
                displayName: friend.peerId,
                text: "Try clearing the cache first.",
            },
            senderPeerId: friend.peerId,
        });

        // A post that races a revocation is rejected by the owner. That rejection runs
        // inside Murmur's store transaction, so it must be dropped rather than escape and
        // stall the cursor for every topic behind it.
        rejectPosts = true;
        await friendTransport.postMember({
            clientMessageId: "post-2",
            displayName: "Dana",
            grant,
            text: "One more thought.",
        });
        await expect(pump(owner, ownerTransport)).resolves.toBeUndefined();
        expect(ownerEvents.filter((event) => event.type === "member_posted")).toHaveLength(1);
        rejectPosts = false;

        await ownerTransport.revoke(grant);
        await pump(friend, friendTransport);

        expect(memberEvents.filter((event) => event.type === "ended")).toHaveLength(1);

        ownerTransport.close();
        friendTransport.close();
    }, 60_000);

    it("re-appends an entry Murmur already committed without degrading the share", async () => {
        const relay = new InMemoryMurmurRelay();
        const owner = createPeer(relay);
        const shareId = "share-replay";
        const transport = new MurmurSessionShareTransport({
            directory: unusedDirectory(),
            entrySource: () => entrySourceOver([]),
            runtime: runtimeOf(owner),
        });
        await transport.createOwner({ ownerPeerId: owner.peerId, shareId });

        const entries = [entry(shareId, 1, "First."), entry(shareId, 2, "Second.")];
        await transport.appendOwnerEntries(shareId, entries);

        // A crash between Murmur's commit and Rig's acknowledgement leaves the entry in
        // Rig's outbox, so the next publish resends it through a transport that has no
        // memory of the send. It must be absorbed, not rejected.
        transport.close();
        const resumed = new MurmurSessionShareTransport({
            directory: unusedDirectory(),
            entrySource: () => entrySourceOver([]),
            runtime: runtimeOf(owner),
        });
        await expect(resumed.appendOwnerEntries(shareId, entries)).resolves.toBeUndefined();
        await expect(
            resumed.appendOwnerEntries(shareId, [entry(shareId, 3, "Third.")]),
        ).resolves.toBeUndefined();

        resumed.close();
    }, 30_000);

    it("revokes a member who is no longer a Murmur friend", async () => {
        const relay = new InMemoryMurmurRelay();
        const owner = createPeer(relay);
        const friend = createPeer(relay);
        const shareId = "share-revoke";
        const friendBundle = createMlsKeyPackage(friend.identity);
        const transport = new MurmurSessionShareTransport({
            directory: {
                ...unusedDirectory(),
                deliver: async () => undefined,
                // The member was unfriended after being invited, so the directory can no
                // longer resolve them at all. Removal must never depend on friendship.
                identity: async () => friend.identity,
                keyPackage: async () => friendBundle.keyPackage,
            },
            entrySource: () => entrySourceOver([]),
            runtime: runtimeOf(owner),
        });
        await transport.createOwner({ ownerPeerId: owner.peerId, shareId });
        const grant: SessionShareTransportGrant = {
            grantEpoch: 1,
            murmurPeerId: friend.peerId,
            shareId,
            shareMemberId: "member-1",
        };
        await transport.invite(grant);

        const unfriended = new MurmurSessionShareTransport({
            directory: { ...unusedDirectory(), identity: async () => undefined },
            entrySource: () => entrySourceOver([]),
            runtime: runtimeOf(owner),
        });
        await expect(unfriended.revoke(grant)).resolves.toBeUndefined();

        transport.close();
        unfriended.close();
    }, 30_000);

    it("refuses to add a friend who has not offered a key package", async () => {
        const relay = new InMemoryMurmurRelay();
        const owner = createPeer(relay);
        const friend = createPeer(relay);
        const shareId = "share-beta";
        const requested: string[] = [];
        const transport = new MurmurSessionShareTransport({
            directory: {
                acceptedInvitation: async () => undefined,
                deliver: async () => undefined,
                displayName: async () => "Dana",
                identity: async () => friend.identity,
                keyPackage: async () => undefined,
                requestKeyPackage: async () => {
                    requested.push(friend.peerId);
                },
            },
            entrySource: () => entrySourceOver([]),
            runtime: runtimeOf(owner),
        });

        await transport.createOwner({ ownerPeerId: owner.peerId, shareId });
        await expect(
            transport.invite({
                grantEpoch: 1,
                murmurPeerId: friend.peerId,
                shareId,
                shareMemberId: "member-1",
            }),
        ).rejects.toThrow("no key package left");
        // Running out is ordinary, so the transport asks the friend for a fresh one.
        expect(requested).toEqual([friend.peerId]);

        transport.close();
    }, 30_000);

    it("refuses to own a share for another Murmur account", async () => {
        const relay = new InMemoryMurmurRelay();
        const owner = createPeer(relay);
        const other = createPeer(relay);
        const transport = new MurmurSessionShareTransport({
            directory: {
                acceptedInvitation: async () => undefined,
                deliver: async () => undefined,
                displayName: async () => undefined,
                identity: async () => undefined,
                keyPackage: async () => undefined,
                requestKeyPackage: async () => undefined,
            },
            entrySource: () => entrySourceOver([]),
            runtime: runtimeOf(owner),
        });

        await expect(
            transport.createOwner({ ownerPeerId: other.peerId, shareId: "share-gamma" }),
        ).rejects.toThrow("owned by this Murmur account");

        transport.close();
    }, 30_000);
});

function replicated(
    events: readonly SessionShareTransportMemberEvent[],
): readonly SessionShareOpaqueEntry[] {
    const entries = events.flatMap((event) =>
        event.type === "entries_appended" ? [...event.entries] : [],
    );
    const unique = new Map(entries.map((item) => [item.shareSequence, item]));
    return [...unique.values()].sort((left, right) => left.shareSequence - right.shareSequence);
}
