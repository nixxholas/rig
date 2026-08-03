import { describe, expect, it, vi } from "vitest";

import type { UserMessage } from "../../agent/types.js";
import type { SessionShareReplicaEndedReason } from "../../persistence/session-sharing/types.js";
import { FakeShareTransport } from "../../sharing/FakeShareTransport.js";
import {
    SessionShareService,
    type SessionShareCoreStore,
    type SessionShareFriendInput,
    type SessionShareMemberRecord,
    type SessionShareRecord,
    type SessionShareReplicaRecord,
} from "../SessionShareService.js";
import type {
    ShareOpaqueEntry,
    ShareTransportGrant,
    ShareTransportMemberPost,
} from "../../sharing/ShareTransport.js";

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
            }),
        ).rejects.toThrow("relay offline");
        expect(store.queryShare("share-1")?.state).toBe("degraded");
        expect(store.outbox).toHaveLength(205);

        await service.create({
            friends: [{ displayName: "Casey", murmurPeerId: "peer-casey" }],
            includeFriendMessagesInModel: true,
            ownerPeerId: "peer-owner",
            ownerSessionId: "session-1",
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
        });

        const stopped = await service.stopForArchivedSession("session-1");

        expect(stopped?.state).toBe("stopped");
        expect(stopped?.members).toEqual([expect.objectContaining({ state: "stopped" })]);
        expect(store.queryActiveShareForSession("session-1")).toBeUndefined();
    });
});

class MemorySessionShareStore implements SessionShareCoreStore {
    readonly acknowledgements: number[] = [];
    readonly friendMessages: UserMessage[] = [];
    readonly endedGrants: ShareTransportGrant[] = [];
    readonly operations: string[] = [];
    readonly outbox: ShareOpaqueEntry[] = [];
    replica: SessionShareReplicaRecord | undefined;
    readonly replicaEntries: ShareOpaqueEntry[] = [];
    #share: MutableShare | undefined;
    readonly #dedupe = new Map<string, string>();
    readonly #seedCount: number;

    constructor(seedCount = 0) {
        this.#seedCount = seedCount;
    }

    createShare(input: {
        friends: readonly SessionShareFriendInput[];
        includeFriendMessagesInModel: boolean;
        ownerPeerId: string;
        ownerSessionId: string;
        shareId: string;
    }): SessionShareRecord {
        this.operations.push(`create:${input.shareId}`);
        let memberIndex = 0;
        this.#share = {
            includeFriendMessagesInModel: input.includeFriendMessagesInModel,
            members: input.friends.map((friend) => ({
                ...friend,
                grantEpoch: 1,
                shareId: input.shareId,
                shareMemberId: `member-${String(++memberIndex)}`,
                state: "active",
            })),
            ownerPeerId: input.ownerPeerId,
            ownerSessionId: input.ownerSessionId,
            shareId: input.shareId,
            state: "active",
        };
        for (let sequence = 1; sequence <= this.#seedCount; sequence += 1) {
            this.outbox.push(entry(input.shareId, sequence));
        }
        return this.#cloneShare();
    }

    queryShare(shareId: string): SessionShareRecord | undefined {
        return this.#share?.shareId === shareId ? this.#cloneShare() : undefined;
    }

    queryActiveShareForSession(ownerSessionId: string): SessionShareRecord | undefined {
        return this.#share?.ownerSessionId === ownerSessionId && this.#share.state !== "stopped"
            ? this.#cloneShare()
            : undefined;
    }

    queryRecoverableShares(): readonly SessionShareRecord[] {
        return this.#share === undefined ? [] : [this.#cloneShare()];
    }

    queryEndedGrants(shareId: string): readonly ShareTransportGrant[] {
        this.#requireShare(shareId);
        return structuredClone(this.endedGrants);
    }

    addMember(input: {
        displayName: string;
        murmurPeerId: string;
        shareId: string;
        shareMemberId: string;
    }): SessionShareMemberRecord {
        const share = this.#requireShare(input.shareId);
        const existing = share.members.find((member) => member.murmurPeerId === input.murmurPeerId);
        if (existing !== undefined) {
            existing.displayName = input.displayName;
            existing.grantEpoch += 1;
            existing.state = "active";
            return { ...existing };
        }
        const member: MutableMember = {
            ...input,
            grantEpoch: 1,
            state: "active",
        };
        share.members.push(member);
        return { ...member };
    }

    revokeMember(shareId: string, shareMemberId: string): SessionShareMemberRecord {
        const member = this.#requireShare(shareId).members.find(
            (candidate) => candidate.shareMemberId === shareMemberId,
        );
        if (member === undefined) throw new Error("Unknown member");
        this.endedGrants.push(toGrant(member));
        member.state = "revoked";
        return { ...member };
    }

    stopShare(shareId: string): SessionShareRecord {
        const share = this.#requireShare(shareId);
        share.state = "stopped";
        for (const member of share.members) {
            if (member.state === "active") this.endedGrants.push(toGrant(member));
            member.state = "stopped";
        }
        return this.#cloneShare();
    }

    setIncludeFriendMessages(shareId: string, include: boolean): SessionShareRecord {
        this.#requireShare(shareId).includeFriendMessagesInModel = include;
        return this.#cloneShare();
    }

    setShareHealth(shareId: string, state: "active" | "degraded"): void {
        const share = this.#requireShare(shareId);
        if (share.state !== "stopped") share.state = state;
        this.operations.push(`health:${shareId}:${state}`);
    }

    acceptFriendMessage(
        post: ShareTransportMemberPost,
        senderPeerId: string,
        message: UserMessage,
    ) {
        const share = this.#requireShare(post.grant.shareId);
        const member = share.members.find(
            (candidate) =>
                candidate.shareMemberId === post.grant.shareMemberId &&
                candidate.grantEpoch === post.grant.grantEpoch &&
                candidate.murmurPeerId === senderPeerId &&
                candidate.state === "active",
        );
        if (member === undefined) throw new Error("Inactive friend grant");
        const key = [
            post.grant.shareId,
            post.grant.shareMemberId,
            String(post.grant.grantEpoch),
            post.clientMessageId,
        ].join("\u0000");
        const existing = this.#dedupe.get(key);
        if (existing !== undefined) {
            return {
                messageId: existing,
                ownerSessionId: share.ownerSessionId,
                status: "duplicate" as const,
            };
        }
        this.#dedupe.set(key, message.id);
        this.friendMessages.push(structuredClone(message));
        const position = this.friendMessages.length - 1;
        return {
            createdAt: 1,
            event: {
                createdAt: 1,
                data: {
                    delivery: "context" as const,
                    displayText: post.text,
                    message,
                    runId: `friend:${message.id}`,
                },
                id: `friend-event-${String(position)}`,
                sessionId: share.ownerSessionId,
                type: "message_submitted" as const,
            },
            message,
            ownerSessionId: share.ownerSessionId,
            overflowedMessageIds: [],
            position,
            status: "accepted" as const,
        };
    }

    queryOutboxPage(
        shareId: string,
        limits: { maxBytes: number; maxItems: number },
    ): readonly ShareOpaqueEntry[] {
        this.#requireShare(shareId);
        const selected: ShareOpaqueEntry[] = [];
        let bytes = 0;
        for (const candidate of this.outbox) {
            const next = Buffer.byteLength(candidate.canonicalJson);
            if (selected.length >= limits.maxItems || bytes + next > limits.maxBytes) break;
            selected.push(candidate);
            bytes += next;
        }
        return selected;
    }

    tailOutbox(_shareId: string): number {
        return 0;
    }

    acknowledgeOutbox(shareId: string, throughShareSequence: number): void {
        this.#requireShare(shareId);
        this.acknowledgements.push(throughShareSequence);
        this.outbox.splice(
            0,
            this.outbox.findLastIndex(
                (candidate) => candidate.shareSequence <= throughShareSequence,
            ) + 1,
        );
    }

    saveReplica(replica: SessionShareReplicaRecord): void {
        const previousEpoch = this.replica?.grant.grantEpoch;
        if (
            this.replica === undefined ||
            replica.grant.grantEpoch >= this.replica.grant.grantEpoch
        ) {
            this.replica = structuredClone(replica);
            if (previousEpoch !== undefined && replica.grant.grantEpoch > previousEpoch) {
                this.replicaEntries.length = 0;
            }
        }
    }

    failAppend: Error | undefined;
    readonly endedReplicaReasons: string[] = [];

    appendReplicaEntries(grant: ShareTransportGrant, entries: readonly ShareOpaqueEntry[]): void {
        if (this.failAppend !== undefined) throw this.failAppend;
        if (this.replica?.grant.grantEpoch !== grant.grantEpoch) return;
        const existing = new Set(this.replicaEntries.map((candidate) => candidate.shareEventId));
        for (const candidate of entries) {
            if (!existing.has(candidate.shareEventId)) this.replicaEntries.push(candidate);
        }
    }

    endReplica(
        grant: ShareTransportGrant,
        reason: SessionShareReplicaEndedReason,
    ): "ended" | "stale" {
        if (
            this.replica?.grant.grantEpoch !== grant.grantEpoch ||
            this.replica.grant.shareMemberId !== grant.shareMemberId
        ) {
            return "stale";
        }
        this.endedReplicaReasons.push(reason);
        this.replica = { ...this.replica, state: "ended" };
        if (reason !== "unreadable") this.replicaEntries.length = 0;
        return "ended";
    }

    #requireShare(shareId: string): MutableShare {
        if (this.#share?.shareId !== shareId) throw new Error("Unknown share");
        return this.#share;
    }

    #cloneShare(): SessionShareRecord {
        return structuredClone(this.#share!);
    }
}

interface MutableMember {
    displayName: string;
    grantEpoch: number;
    murmurPeerId: string;
    shareId: string;
    shareMemberId: string;
    state: "active" | "revoked" | "stopped";
}

interface MutableShare {
    includeFriendMessagesInModel: boolean;
    members: MutableMember[];
    ownerPeerId: string;
    ownerSessionId: string;
    shareId: string;
    state: "active" | "degraded" | "stopped";
}

function sequenceIds(...ids: string[]): () => string {
    return () => ids.shift()!;
}

function toGrant(member: SessionShareMemberRecord): ShareTransportGrant {
    return {
        grantEpoch: member.grantEpoch,
        murmurPeerId: member.murmurPeerId,
        shareId: member.shareId,
        shareMemberId: member.shareMemberId,
    };
}

function entry(shareId: string, shareSequence: number): ShareOpaqueEntry {
    return {
        canonicalJson: JSON.stringify({ value: "x".repeat(16), shareSequence }),
        contentHash: `hash-${String(shareSequence)}`,
        createdAt: shareSequence,
        shareEventId: `event-${String(shareSequence)}`,
        shareId,
        shareSequence,
    };
}
