import { describe, expect, it, vi } from "vitest";

import { FakeShareTransport } from "../../sharing/FakeShareTransport.js";
import { SessionShareService } from "../SessionShareService.js";
import type { ShareTransportMemberPost } from "../../sharing/ShareTransport.js";
import { MemorySessionShareStore, sequenceIds, toGrant } from "./sessionShareTestFixtures.js";

describe("SessionShareService", () => {
    it("persists first, invites the initial friends as one batch, and deduplicates friend posts", async () => {
        const transport = new FakeShareTransport();
        const store = new MemorySessionShareStore();
        const delivered = vi.fn();
        const ids = ["share-1", "member-1", "member-2", "message-1", "message-duplicate"];
        const service = new SessionShareService({
            deliverFriendMessage: delivered,
            idFactory: () => ids.shift()!,
            store,
            transport,
        });

        const share = await service.create({
            friends: [
                { displayName: "Casey", murmurPeerId: "peer-casey" },
                { displayName: "Riley", murmurPeerId: "peer-riley" },
            ],
            includeFriendMessagesInModel: false,
            ownerPeerId: "peer-owner",
            ownerSessionId: "session-1",
            toolOutput: "summaries",
        });

        expect(share.members).toHaveLength(2);
        expect(store.operations.slice(0, 2)).toEqual(["create:share-1", "health:share-1:active"]);
        const grant = toGrant(share.members[0]!);
        const post: ShareTransportMemberPost = {
            clientMessageId: "client-1",
            displayName: "Casey",
            grant,
            text: "Keep the release narrow.",
        };
        await transport.postMember(post);
        await transport.postMember(post);

        expect(delivered).toHaveBeenCalledTimes(1);
        expect(delivered).toHaveBeenCalledWith(
            "session-1",
            expect.objectContaining({
                contextOnly: true,
                friendAuthor: expect.objectContaining({
                    kind: "friend",
                    murmurPeerId: "peer-casey",
                    shareId: "share-1",
                }),
            }),
            expect.objectContaining({ createdAt: 1, position: 0 }),
        );
        expect(store.friendMessages).toHaveLength(1);
    });

    it("publishes huge history in bounded pages, degrades on failure, and resumes from the ack", async () => {
        const transport = new FakeShareTransport();
        const store = new MemorySessionShareStore(205);
        const service = new SessionShareService({
            deliverFriendMessage: () => undefined,
            idFactory: sequenceIds("share-1", "member-1"),
            store,
            transport,
        });
        transport.failNext("append", new Error("relay offline"));

        await expect(
            service.create({
                friends: [{ displayName: "Casey", murmurPeerId: "peer-casey" }],
                includeFriendMessagesInModel: true,
                ownerPeerId: "peer-owner",
                ownerSessionId: "session-1",
                toolOutput: "summaries",
            }),
        ).rejects.toThrow("relay offline");
        expect(store.queryShare("share-1")?.state).toBe("degraded");
        expect(store.outbox).toHaveLength(205);

        await service.create({
            friends: [{ displayName: "Casey", murmurPeerId: "peer-casey" }],
            includeFriendMessagesInModel: true,
            ownerPeerId: "peer-owner",
            ownerSessionId: "session-1",
            toolOutput: "summaries",
        });
        expect(store.outbox).toHaveLength(0);
        expect(store.acknowledgements).toEqual([100, 200, 205]);
        expect(store.queryShare("share-1")?.state).toBe("active");
    });

    it("keeps stable member identity across grant epochs and ignores delayed old ended events", async () => {
        const transport = new FakeShareTransport();
        transport.setAutoDeliver(false);
        const store = new MemorySessionShareStore(1);
        const service = new SessionShareService({
            deliverFriendMessage: () => undefined,
            idFactory: sequenceIds("share-1", "member-1", "unused-new-member"),
            store,
            transport,
        });
        const share = await service.create({
            friends: [{ displayName: "Casey", murmurPeerId: "peer-casey" }],
            includeFriendMessagesInModel: true,
            ownerPeerId: "peer-owner",
            ownerSessionId: "session-1",
            toolOutput: "summaries",
        });
        const oldGrant = toGrant(share.members[0]!);
        await service.joinReplica({
            grant: oldGrant,
            memberCount: 1,
            ownerPeerId: "peer-owner",
            state: "active",
            title: "Shared session",
        });

        const revokePromise = service.revoke(share.shareId, oldGrant.shareMemberId);
        const readded = await service.add({
            displayName: "Casey again",
            murmurPeerId: oldGrant.murmurPeerId,
            shareId: share.shareId,
        });
        const newGrant = toGrant(readded);
        expect(newGrant.shareMemberId).toBe(oldGrant.shareMemberId);
        expect(newGrant.grantEpoch).toBe(2);
        await service.joinReplica({
            grant: newGrant,
            memberCount: 1,
            ownerPeerId: "peer-owner",
            state: "active",
            title: "Shared session",
        });

        await transport.flushAll({ reverse: true });
        await revokePromise;
        expect(store.replica?.grant.grantEpoch).toBe(2);
        expect(store.replica?.state).toBe("active");
        expect(store.replicaEntries.length).toBeGreaterThan(0);
    });

    it("keeps a replica's transcript when re-joining its next epoch fails", async () => {
        const transport = new FakeShareTransport();
        transport.setAutoDeliver(false);
        const store = new MemorySessionShareStore(1);
        const service = new SessionShareService({
            deliverFriendMessage: () => undefined,
            idFactory: sequenceIds("share-1", "member-1"),
            store,
            transport,
        });
        const share = await service.create({
            friends: [{ displayName: "Casey", murmurPeerId: "peer-casey" }],
            includeFriendMessagesInModel: true,
            ownerPeerId: "peer-owner",
            ownerSessionId: "session-1",
            toolOutput: "summaries",
        });
        const grant = toGrant(share.members[0]!);
        await service.joinReplica({
            grant,
            memberCount: 1,
            ownerPeerId: "peer-owner",
            state: "active",
            title: "Shared session",
        });
        await transport.flushAll();
        const replicated = store.replicaEntries.length;
        expect(replicated).toBeGreaterThan(0);

        // A replayed invitation spends a one-use bundle that is already gone, so the join
        // fails. Adopting its epoch anyway would discard everything the live epoch holds.
        transport.failNext("join");
        await expect(
            service.joinReplica({
                grant: { ...grant, grantEpoch: grant.grantEpoch + 1 },
                memberCount: 1,
                ownerPeerId: "peer-owner",
                state: "active",
                title: "Shared session",
            }),
        ).rejects.toThrow("Fake join failure");

        expect(store.replica?.grant.grantEpoch).toBe(grant.grantEpoch);
        expect(store.replicaEntries).toHaveLength(replicated);
    });

    it("repairs a revocation that never reached the transport", async () => {
        const transport = new FakeShareTransport();
        const store = new MemorySessionShareStore();
        const service = new SessionShareService({
            deliverFriendMessage: () => undefined,
            idFactory: sequenceIds("share-1", "member-1", "member-2"),
            store,
            transport,
        });
        const share = await service.create({
            friends: [{ displayName: "Casey", murmurPeerId: "peer-casey" }],
            includeFriendMessagesInModel: true,
            ownerPeerId: "peer-owner",
            ownerSessionId: "session-1",
            toolOutput: "summaries",
        });
        const grant = toGrant(share.members[0]!);

        // The durable revocation lands but the transport call fails, so Rig says revoked
        // while the member is still in the group and still decrypting every entry.
        transport.failNext("revoke");
        await expect(service.revoke(share.shareId, grant.shareMemberId)).rejects.toThrow(
            "Fake revoke failure",
        );
        expect(transport.grantsFor(share.shareId)).toContainEqual(grant);

        await service.recover();

        expect(transport.grantsFor(share.shareId)).not.toContainEqual(grant);
        expect(store.queryShare(share.shareId)?.state).toBe("active");
    });

    it("never re-revokes a friend who was invited back", async () => {
        const transport = new FakeShareTransport();
        const store = new MemorySessionShareStore();
        const service = new SessionShareService({
            deliverFriendMessage: () => undefined,
            idFactory: sequenceIds("share-1", "member-1"),
            store,
            transport,
        });
        const share = await service.create({
            friends: [{ displayName: "Casey", murmurPeerId: "peer-casey" }],
            includeFriendMessagesInModel: true,
            ownerPeerId: "peer-owner",
            ownerSessionId: "session-1",
            toolOutput: "summaries",
        });
        const grant = toGrant(share.members[0]!);
        await service.revoke(share.shareId, grant.shareMemberId);
        const readded = await service.add({
            displayName: "Casey again",
            murmurPeerId: grant.murmurPeerId,
            shareId: share.shareId,
        });

        // A revocation names only the peer, so replaying the ended epoch would remove the
        // membership that same friend holds right now.
        await service.recover();

        expect(transport.grantsFor(share.shareId)).toContainEqual(toGrant(readded));
        expect(store.queryShare(share.shareId)?.state).toBe("active");
    });

    it("ends a replica the owner sent an entry it cannot apply", async () => {
        const transport = new FakeShareTransport();
        transport.setAutoDeliver(false);
        const store = new MemorySessionShareStore(1);
        const service = new SessionShareService({
            deliverFriendMessage: () => undefined,
            idFactory: sequenceIds("share-1", "member-1"),
            store,
            transport,
        });
        const share = await service.create({
            friends: [{ displayName: "Casey", murmurPeerId: "peer-casey" }],
            includeFriendMessagesInModel: true,
            ownerPeerId: "peer-owner",
            ownerSessionId: "session-1",
            toolOutput: "summaries",
        });
        const grant = toGrant(share.members[0]!);
        await service.joinReplica({
            grant,
            memberCount: 1,
            ownerPeerId: "peer-owner",
            state: "active",
            title: "Shared session",
        });
        await transport.flushAll();

        // A replica's visible transcript stops at its first gap, so an entry it can never
        // apply would silently freeze it while it still reported active.
        store.failAppend = new Error("The replica entry conflicts with an existing event.");
        await transport.appendOwnerEntries(share.shareId, [
            {
                canonicalJson: '{"kind":"conflict"}',
                contentHash: "hash-conflict",
                createdAt: 5,
                shareEventId: "event-conflict",
                shareId: share.shareId,
                shareSequence: 99,
            },
        ]);
        await transport.flushAll();
        // The runtime's event router flushes once Murmur's transaction has committed; a
        // replica end is deliberately not applied inside it.
        service.flushReplicaEnds();

        expect(store.replica?.state).toBe("ended");
        expect(store.endedReplicaReasons).toContain("unreadable");
        // A local read failure is not a removal, so the member keeps the transcript it
        // legitimately received and hash-verified up to where it stopped.
        expect(store.replicaEntries.length).toBeGreaterThan(0);
    });

    it("stops a share terminally when its owner session is archived", async () => {
        const transport = new FakeShareTransport();
        const store = new MemorySessionShareStore();
        const service = new SessionShareService({
            deliverFriendMessage: () => undefined,
            idFactory: sequenceIds("share-1", "member-1"),
            store,
            transport,
        });
        await service.create({
            friends: [{ displayName: "Casey", murmurPeerId: "peer-casey" }],
            includeFriendMessagesInModel: true,
            ownerPeerId: "peer-owner",
            ownerSessionId: "session-1",
            toolOutput: "summaries",
        });

        const stopped = await service.stopForArchivedSession("session-1");

        expect(stopped?.state).toBe("stopped");
        expect(stopped?.members).toEqual([expect.objectContaining({ state: "stopped" })]);
        expect(store.queryActiveShareForSession("session-1")).toBeUndefined();
    });
});
