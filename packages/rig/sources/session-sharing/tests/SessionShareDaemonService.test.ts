import { describe, expect, it, vi } from "vitest";

import { PersistentSessionStore } from "../../session/PersistentSessionStore.js";
import {
    canonicalSessionShareJson,
    sessionShareContentHash,
} from "../canonicalSessionShareJson.js";
import { FakeSessionShareTransport } from "../FakeSessionShareTransport.js";
import { SessionShareDaemonService } from "../SessionShareDaemonService.js";
import { SessionShareService } from "../SessionShareService.js";

/**
 * Wires the real durable stores (via a real, in-memory-database `PersistentSessionStore`) to the
 * deterministic transport, exactly the way `createSessionShareRuntime` wires the real Murmur
 * transport in production.
 */
function makeContext(options: { localPeerId?: () => Promise<string | undefined> } = {}): {
    daemon: SessionShareDaemonService;
    deliverFriendMessage: ReturnType<typeof vi.fn>;
    service: SessionShareService;
    store: PersistentSessionStore;
    transport: FakeSessionShareTransport;
} {
    const store = new PersistentSessionStore({ databasePath: ":memory:" });
    const transport = new FakeSessionShareTransport();
    const deliverFriendMessage = vi.fn();
    const service = new SessionShareService({
        deliverFriendMessage,
        store: store.sessionShares,
        transport,
    });
    const daemon = new SessionShareDaemonService({
        localPeerId: options.localPeerId ?? (async () => "peer-owner"),
        service,
        store: store.sessionShareDaemonStore,
    });
    return { daemon, deliverFriendMessage, service, store, transport };
}

describe("SessionShareDaemonService with a real database and the deterministic transport", () => {
    it("returns undefined for an unshared session, then the share and its members after create", async () => {
        const { daemon, store } = makeContext();
        try {
            const sessionId = store.create({ cwd: "/tmp/session-share-owner-1" }).id;
            expect(daemon.getOwner(sessionId)).toBeUndefined();

            await daemon.create(sessionId, {
                friends: [{ displayName: "Casey", peerId: "peer-casey" }],
                includeFriendMessagesInModel: true,
                mutationId: "mutation-1",
            });

            const owner = daemon.getOwner(sessionId);
            expect(owner?.share).toMatchObject({
                includeFriendMessagesInModel: true,
                memberCount: 1,
                state: "active",
            });
            expect(owner?.members).toMatchObject([
                { displayName: "Casey", murmurPeerId: "peer-casey", state: "active" },
            ]);
        } finally {
            store.close();
        }
    });

    it("maps friends[].peerId onto members and counts only active members in memberCount", async () => {
        const { daemon, store } = makeContext();
        try {
            const sessionId = store.create({ cwd: "/tmp/session-share-owner-2" }).id;
            const created = await daemon.create(sessionId, {
                friends: [
                    { displayName: "Casey", peerId: "peer-casey" },
                    { displayName: "Riley", peerId: "peer-riley" },
                ],
                includeFriendMessagesInModel: false,
                mutationId: "mutation-1",
            });

            expect(
                created.members
                    .map((member): [string, string] => [member.displayName, member.murmurPeerId])
                    .sort((left, right) => left[0].localeCompare(right[0])),
            ).toEqual([
                ["Casey", "peer-casey"],
                ["Riley", "peer-riley"],
            ]);
            expect(created.share.memberCount).toBe(2);
        } finally {
            store.close();
        }
    });

    it("reflects add then revoke through getOwner, keeping a revoked member listed but uncounted", async () => {
        const { daemon, store } = makeContext();
        try {
            const sessionId = store.create({ cwd: "/tmp/session-share-owner-3" }).id;
            await daemon.create(sessionId, {
                friends: [{ displayName: "Casey", peerId: "peer-casey" }],
                includeFriendMessagesInModel: true,
                mutationId: "mutation-1",
            });

            const added = await daemon.add(sessionId, {
                friend: { displayName: "Riley", peerId: "peer-riley" },
                mutationId: "mutation-2",
            });
            expect(added.share.memberCount).toBe(2);
            const rileyMemberId = added.members.find(
                (member) => member.murmurPeerId === "peer-riley",
            )!.shareMemberId;

            const revoked = await daemon.revoke(sessionId, rileyMemberId, {
                mutationId: "mutation-3",
            });
            expect(revoked.share.memberCount).toBe(1);
            expect(
                revoked.members.find((member) => member.shareMemberId === rileyMemberId),
            ).toMatchObject({ state: "revoked" });

            const owner = daemon.getOwner(sessionId);
            expect(owner?.share.memberCount).toBe(1);
            expect(
                owner?.members.find((member) => member.shareMemberId === rileyMemberId),
            ).toMatchObject({ state: "revoked" });
        } finally {
            store.close();
        }
    });

    it("toggles includeFriendMessagesInModel and the change is visible through getOwner", async () => {
        const { daemon, store } = makeContext();
        try {
            const sessionId = store.create({ cwd: "/tmp/session-share-owner-4" }).id;
            const created = await daemon.create(sessionId, {
                friends: [{ displayName: "Casey", peerId: "peer-casey" }],
                includeFriendMessagesInModel: true,
                mutationId: "mutation-1",
            });
            expect(created.share.includeFriendMessagesInModel).toBe(true);

            const toggled = await daemon.setFriendMessages(sessionId, {
                includeFriendMessagesInModel: false,
                mutationId: "mutation-2",
            });
            expect(toggled.share.includeFriendMessagesInModel).toBe(false);
            expect(daemon.getOwner(sessionId)?.share.includeFriendMessagesInModel).toBe(false);
        } finally {
            store.close();
        }
    });

    it("marks the share stopped, after which getOwner reports no active share for the session", async () => {
        const { daemon, store } = makeContext();
        try {
            const sessionId = store.create({ cwd: "/tmp/session-share-owner-5" }).id;
            await daemon.create(sessionId, {
                friends: [{ displayName: "Casey", peerId: "peer-casey" }],
                includeFriendMessagesInModel: true,
                mutationId: "mutation-1",
            });

            const stopped = await daemon.stop(sessionId, { mutationId: "mutation-2" });
            expect(stopped.share.state).toBe("stopped");
            expect(daemon.getOwner(sessionId)).toBeUndefined();
        } finally {
            store.close();
        }
    });

    it("reports pending outbox bytes/entries and share state, and undefined for an unknown share", async () => {
        const { daemon, store, transport } = makeContext();
        try {
            const sessionId = store.create({ cwd: "/tmp/session-share-owner-6" }).id;
            // The initial share snapshot only enqueues an outbox entry when the owner session
            // already has a durable message to project, so seed one before creating the share.
            store.upsertMessage(sessionId, {
                isPartial: false,
                message: {
                    blocks: [{ text: "Seed", type: "text" }],
                    id: "seed-message",
                    role: "user",
                },
                position: 0,
            });
            transport.failNext("append", new Error("relay offline"));

            await expect(
                daemon.create(sessionId, {
                    friends: [{ displayName: "Casey", peerId: "peer-casey" }],
                    includeFriendMessagesInModel: false,
                    mutationId: "mutation-1",
                }),
            ).rejects.toThrow("relay offline");

            const shareId = daemon.getOwner(sessionId)!.share.shareId;
            const health = daemon.health(shareId);
            expect(health?.health).toMatchObject({ state: "degraded" });
            expect(health?.health.pendingBytes).toBeGreaterThan(0);
            expect(health?.health.pendingEntries).toBeGreaterThan(0);

            expect(daemon.health("unknown-share")).toBeUndefined();
        } finally {
            store.close();
        }
    });

    it("fails create with a clear message when the local Murmur account has no peer ID", async () => {
        const { store, service } = makeContext();
        try {
            const sessionId = store.create({ cwd: "/tmp/session-share-owner-7" }).id;
            const daemonWithoutPeer = new SessionShareDaemonService({
                localPeerId: async () => undefined,
                service,
                store: store.sessionShareDaemonStore,
            });

            await expect(
                daemonWithoutPeer.create(sessionId, {
                    friends: [{ displayName: "Casey", peerId: "peer-casey" }],
                    includeFriendMessagesInModel: true,
                    mutationId: "mutation-1",
                }),
            ).rejects.toThrow("Set up a Murmur account before sharing a session.");
        } finally {
            store.close();
        }
    });

    it("pages replica history in ascending order, continues the cursor, and completes on the last page", async () => {
        const { daemon, store } = makeContext();
        try {
            const grant = {
                grantEpoch: 1,
                murmurPeerId: "peer-remote-owner",
                shareId: "remote-share",
                shareMemberId: "remote-member",
            };
            store.sessionShares.saveReplica({
                grant,
                memberCount: 1,
                ownerPeerId: "peer-remote-owner",
                state: "active",
                title: "Remote session",
            });
            const entries = Array.from({ length: 150 }, (_unused, index) => {
                const sequence = index + 1;
                const canonicalJson = canonicalSessionShareJson({ sequence });
                return {
                    canonicalJson,
                    contentHash: sessionShareContentHash(canonicalJson),
                    createdAt: sequence,
                    shareEventId: `remote-event-${String(sequence)}`,
                    shareId: grant.shareId,
                    shareSequence: sequence,
                };
            });
            store.sessionShares.appendReplicaEntries(grant, entries);

            const firstPage = daemon.replicaHistory(grant.shareId);
            expect(firstPage?.complete).toBe(false);
            expect(firstPage?.entries).toHaveLength(100);
            expect(firstPage?.entries.map((entry) => entry.shareSequence)).toEqual(
                Array.from({ length: 100 }, (_unused, index) => index + 1),
            );
            expect(firstPage?.nextCursor).toBe("100");

            const secondPage = daemon.replicaHistory(grant.shareId, firstPage?.nextCursor);
            expect(secondPage?.complete).toBe(true);
            expect(secondPage?.nextCursor).toBeUndefined();
            expect(secondPage?.entries.map((entry) => entry.shareSequence)).toEqual(
                Array.from({ length: 50 }, (_unused, index) => index + 101),
            );

            expect(() => daemon.replicaHistory(grant.shareId, "not-a-number")).toThrow(
                "The shared session history cursor is not valid.",
            );
            expect(daemon.replicaHistory("unknown-share")).toBeUndefined();
        } finally {
            store.close();
        }
    });

    it("rejects posting to an inactive replica, and accepts it once the replica is active", async () => {
        const { daemon, service, store } = makeContext();
        try {
            const sessionId = store.create({ cwd: "/tmp/session-share-owner-9" }).id;

            await expect(
                daemon.postFriendMessage({
                    clientMessageId: "client-1",
                    grant: {
                        grantEpoch: 1,
                        murmurPeerId: "peer-friend",
                        shareId: "share-unknown",
                        shareMemberId: "member-1",
                    },
                    text: "Hello",
                }),
            ).rejects.toThrow("This shared session is no longer active.");

            const created = await daemon.create(sessionId, {
                friends: [{ displayName: "Friend", peerId: "peer-friend" }],
                includeFriendMessagesInModel: true,
                mutationId: "mutation-1",
            });
            const member = created.members[0]!;
            const grant = {
                grantEpoch: member.currentGrantEpoch,
                murmurPeerId: member.murmurPeerId,
                shareId: member.shareId,
                shareMemberId: member.shareMemberId,
            };
            // `postFriendMessage` sends `replica.title` as the poster's authenticated display
            // name (SessionShareDaemonService.ts:198), and the owner accepts a friend message
            // only when that name matches the display name it registered for this member
            // (sessionShareFriendMessageSave.ts:73). The title must match that registered name.
            await service.joinReplica({
                grant,
                memberCount: 1,
                ownerPeerId: "peer-owner",
                state: "active",
                title: member.displayName,
            });

            expect(
                await daemon.postFriendMessage({
                    clientMessageId: "client-2",
                    grant,
                    text: "Hi there",
                }),
            ).toEqual({ accepted: true, clientMessageId: "client-2" });

            await daemon.revoke(sessionId, member.shareMemberId, { mutationId: "mutation-2" });

            await expect(
                daemon.postFriendMessage({
                    clientMessageId: "client-3",
                    grant,
                    text: "Still here?",
                }),
            ).rejects.toThrow("This shared session is no longer active.");
        } finally {
            store.close();
        }
    });
});
