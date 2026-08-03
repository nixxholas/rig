import { createId } from "@paralleldrive/cuid2";
import { Value } from "@sinclair/typebox/value";

import type { UserMessage } from "../agent/types.js";
import { asyncQueue, type AsyncQueue } from "../concurrency/index.js";
import type { FriendAuthor } from "./FriendAuthor.js";
import type {
    SessionShareOpaqueEntry,
    SessionShareTransport,
    SessionShareTransportGrant,
    SessionShareTransportMemberPost,
} from "./SessionShareTransport.js";
import {
    sessionShareTransportMemberEventSchema,
    sessionShareTransportOwnerEventSchema,
} from "./SessionShareTransport.js";

const MAX_PAGE_COUNT = 100;
const MAX_PAGE_BYTES = 256 * 1024;

export type SessionShareState = "active" | "degraded" | "stopped";
export type SessionShareMemberState = "active" | "revoked" | "stopped";

export interface SessionShareRecord {
    readonly includeFriendMessagesInModel: boolean;
    readonly members: readonly SessionShareMemberRecord[];
    readonly ownerPeerId: string;
    readonly ownerSessionId: string;
    readonly shareId: string;
    readonly state: SessionShareState;
}

export interface SessionShareMemberRecord {
    readonly displayName: string;
    readonly grantEpoch: number;
    readonly murmurPeerId: string;
    readonly shareId: string;
    readonly shareMemberId: string;
    readonly state: SessionShareMemberState;
}

export interface SessionShareFriendInput {
    readonly displayName: string;
    readonly murmurPeerId: string;
}

/**
 * An authenticated friend post the current grant does not accept.
 *
 * This is an ordinary race, not a failure: the owner revokes or stops while a
 * post is already in flight. It is raised as its own type so the service can
 * drop the post and let Murmur's cursor advance, instead of letting a rejection
 * escape into the shared sync loop and stall every topic behind it.
 */
export class SessionShareUnauthorizedPostError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "SessionShareUnauthorizedPostError";
    }
}

export interface SessionShareReplicaRecord {
    readonly grant: SessionShareTransportGrant;
    readonly memberCount: number;
    readonly ownerPeerId: string;
    readonly state: "active" | "ended";
    readonly title: string;
}

export interface SessionShareAcceptedFriendMessage {
    readonly createdAt: number;
    readonly message: UserMessage;
    readonly event: Extract<
        import("../protocol/index.js").SessionEvent,
        {
            type: "message_submitted";
        }
    >;
    readonly ownerSessionId: string;
    readonly overflowedMessageIds: readonly string[];
    readonly position: number;
    readonly status: "accepted";
}

export interface SessionShareDuplicateFriendMessage {
    readonly messageId: string;
    readonly ownerSessionId: string;
    readonly status: "duplicate";
}

export interface SessionShareCoreStore {
    createShare(input: {
        friends: readonly SessionShareFriendInput[];
        includeFriendMessagesInModel: boolean;
        ownerPeerId: string;
        ownerSessionId: string;
        shareId: string;
    }): SessionShareRecord;
    queryShare(shareId: string): SessionShareRecord | undefined;
    queryActiveShareForSession(ownerSessionId: string): SessionShareRecord | undefined;
    queryRecoverableShares(): readonly SessionShareRecord[];
    queryEndedGrants(shareId: string): readonly SessionShareTransportGrant[];
    addMember(input: {
        displayName: string;
        murmurPeerId: string;
        shareId: string;
        shareMemberId: string;
    }): SessionShareMemberRecord;
    revokeMember(shareId: string, shareMemberId: string): SessionShareMemberRecord;
    stopShare(shareId: string): SessionShareRecord;
    setIncludeFriendMessages(shareId: string, include: boolean): SessionShareRecord;
    setShareHealth(shareId: string, state: "active" | "degraded"): void;
    acceptFriendMessage(
        post: SessionShareTransportMemberPost,
        senderPeerId: string,
        message: UserMessage,
    ): SessionShareAcceptedFriendMessage | SessionShareDuplicateFriendMessage;
    tailOutbox(shareId: string): number;
    queryOutboxPage(
        shareId: string,
        limits: { maxBytes: number; maxItems: number },
    ): readonly SessionShareOpaqueEntry[];
    acknowledgeOutbox(shareId: string, throughShareSequence: number): void;
    saveReplica(replica: SessionShareReplicaRecord): void;
    appendReplicaEntries(
        grant: SessionShareTransportGrant,
        entries: readonly SessionShareOpaqueEntry[],
    ): void;
    endReplica(grant: SessionShareTransportGrant, reason: "revoked" | "stopped"): "ended" | "stale";
}

export interface SessionShareServiceOptions {
    readonly deliverFriendMessage: (
        ownerSessionId: string,
        message: UserMessage,
        persisted: {
            createdAt: number;
            event: Extract<
                import("../protocol/index.js").SessionEvent,
                {
                    type: "message_submitted";
                }
            >;
            overflowedMessageIds: readonly string[];
            position: number;
        },
    ) => void | Promise<void>;
    readonly idFactory?: () => string;
    readonly store: SessionShareCoreStore;
    readonly transport: SessionShareTransport;
}

export class SessionShareService {
    readonly #deliverFriendMessage: SessionShareServiceOptions["deliverFriendMessage"];
    readonly #idFactory: () => string;
    readonly #ownerSubscriptions = new Map<string, () => void>();
    readonly #memberSubscriptions = new Map<string, () => void>();
    readonly #publishQueues = new Map<string, AsyncQueue>();
    readonly #publishRequested = new Set<string>();
    readonly #store: SessionShareCoreStore;
    readonly #transport: SessionShareTransport;
    #closed = false;

    constructor(options: SessionShareServiceOptions) {
        this.#deliverFriendMessage = options.deliverFriendMessage;
        this.#idFactory = options.idFactory ?? createId;
        this.#store = options.store;
        this.#transport = options.transport;
    }

    async create(input: {
        friends: readonly SessionShareFriendInput[];
        includeFriendMessagesInModel: boolean;
        ownerPeerId: string;
        ownerSessionId: string;
    }): Promise<SessionShareRecord> {
        this.#assertOpen();
        if (input.friends.length === 0)
            throw new Error("A session share needs at least one friend.");
        const existing = this.#store.queryActiveShareForSession(input.ownerSessionId);
        if (existing !== undefined) {
            await this.#recoverShare(existing);
            return this.#store.queryShare(existing.shareId) ?? existing;
        }
        const share = this.#store.createShare({ ...input, shareId: this.#idFactory() });
        this.#subscribeOwner(share.shareId);
        try {
            await this.#transport.createOwner({
                ownerPeerId: share.ownerPeerId,
                shareId: share.shareId,
            });
            await this.#transport.inviteMany(activeGrants(share));
            await this.publish(share.shareId);
            this.#store.setShareHealth(share.shareId, "active");
        } catch (error: unknown) {
            this.#store.setShareHealth(share.shareId, "degraded");
            throw error;
        }
        return this.#store.queryShare(share.shareId) ?? share;
    }

    async add(input: {
        displayName: string;
        murmurPeerId: string;
        shareId: string;
    }): Promise<SessionShareMemberRecord> {
        this.#assertOpen();
        const member = this.#store.addMember({ ...input, shareMemberId: this.#idFactory() });
        const grant = memberGrant(member);
        try {
            await this.#transport.invite(grant);
            this.#store.setShareHealth(input.shareId, "active");
        } catch (error: unknown) {
            this.#store.setShareHealth(input.shareId, "degraded");
            throw error;
        }
        return member;
    }

    async revoke(shareId: string, shareMemberId: string): Promise<SessionShareMemberRecord> {
        this.#assertOpen();
        const member = this.#store.revokeMember(shareId, shareMemberId);
        try {
            await this.#transport.revoke(memberGrant(member));
        } catch (error: unknown) {
            this.#store.setShareHealth(shareId, "degraded");
            throw error;
        }
        return member;
    }

    async stop(shareId: string): Promise<SessionShareRecord> {
        this.#assertOpen();
        const share = this.#store.stopShare(shareId);
        const queue = this.#publishQueues.get(shareId) ?? asyncQueue();
        this.#publishQueues.set(shareId, queue);
        try {
            await queue.runInLock(() => this.#transport.stop(shareId, this.#allKnownGrants(share)));
        } finally {
            this.#ownerSubscriptions.get(shareId)?.();
            this.#ownerSubscriptions.delete(shareId);
        }
        return share;
    }

    async stopForArchivedSession(ownerSessionId: string): Promise<SessionShareRecord | undefined> {
        const share = this.#store.queryActiveShareForSession(ownerSessionId);
        return share === undefined ? undefined : this.stop(share.shareId);
    }

    toggle(shareId: string, includeFriendMessagesInModel: boolean): SessionShareRecord {
        this.#assertOpen();
        return this.#store.setIncludeFriendMessages(shareId, includeFriendMessagesInModel);
    }

    async recover(): Promise<void> {
        this.#assertOpen();
        for (const share of this.#store.queryRecoverableShares()) {
            if (share.state === "stopped") {
                await this.#transport.stop(share.shareId, this.#allKnownGrants(share));
                continue;
            }
            await this.#recoverShare(share);
        }
    }

    wake(shareId: string): void {
        if (this.#closed) return;
        this.#publishRequested.add(shareId);
        void this.publish(shareId).catch(() => {
            // publish() already recorded degraded health. Live wakeups are optional hints; the
            // durable cursor/outbox drives the later retry.
        });
    }

    async publish(shareId: string): Promise<void> {
        this.#assertOpen();
        this.#publishRequested.add(shareId);
        const queue = this.#publishQueues.get(shareId) ?? asyncQueue();
        this.#publishQueues.set(shareId, queue);
        await queue.runInLock(async () => {
            while (this.#publishRequested.delete(shareId)) {
                try {
                    for (;;) {
                        const tailed = this.#store.tailOutbox(shareId);
                        const page = this.#store.queryOutboxPage(shareId, {
                            maxBytes: MAX_PAGE_BYTES,
                            maxItems: MAX_PAGE_COUNT,
                        });
                        if (page.length === 0) {
                            if (tailed > 0) continue;
                            break;
                        }
                        assertPageBounds(page);
                        await this.#transport.appendOwnerEntries(shareId, page);
                        this.#store.acknowledgeOutbox(shareId, page.at(-1)!.shareSequence);
                    }
                    this.#store.setShareHealth(shareId, "active");
                } catch (error: unknown) {
                    this.#store.setShareHealth(shareId, "degraded");
                    throw error;
                }
            }
        });
    }

    async joinReplica(replica: SessionShareReplicaRecord): Promise<void> {
        this.#assertOpen();
        const key = grantKey(replica.grant);
        const previous = this.#memberSubscriptions.get(key);
        previous?.();
        this.#memberSubscriptions.set(
            key,
            this.#transport.handleMemberEvents(replica.grant, (event) =>
                this.#handleMemberEvent(event),
            ),
        );
        try {
            // Saving the replica adopts the new grant epoch, which discards everything the
            // previous epoch replicated. A join that fails — a replayed invitation whose
            // one-use bundle is already spent, say — must not cost the member the
            // transcript it still holds, so the durable epoch moves only after Murmur has
            // accepted the membership.
            await this.#transport.joinMember(replica.grant);
        } catch (error: unknown) {
            this.#memberSubscriptions.get(key)?.();
            this.#memberSubscriptions.delete(key);
            throw error;
        }
        this.#store.saveReplica(replica);
    }

    // A replica restored on daemon start is already durable and its Murmur session is
    // reloaded by the transport, so resuming only needs the event subscription back.
    observeReplica(grant: SessionShareTransportGrant): void {
        this.#assertOpen();
        const key = grantKey(grant);
        this.#memberSubscriptions.get(key)?.();
        this.#memberSubscriptions.set(
            key,
            this.#transport.handleMemberEvents(grant, (event) => this.#handleMemberEvent(event)),
        );
    }

    async post(post: SessionShareTransportMemberPost): Promise<void> {
        this.#assertOpen();
        await this.#transport.postMember(post);
    }

    close(): void {
        if (this.#closed) return;
        this.#closed = true;
        for (const unsubscribe of this.#ownerSubscriptions.values()) unsubscribe();
        for (const unsubscribe of this.#memberSubscriptions.values()) unsubscribe();
        this.#ownerSubscriptions.clear();
        this.#memberSubscriptions.clear();
        this.#publishRequested.clear();
    }

    #subscribeOwner(shareId: string): void {
        if (this.#ownerSubscriptions.has(shareId)) return;
        this.#ownerSubscriptions.set(
            shareId,
            this.#transport.handleOwnerEvents(shareId, (event) => this.#handleOwnerEvent(event)),
        );
    }

    async #recoverShare(share: SessionShareRecord): Promise<void> {
        this.#subscribeOwner(share.shareId);
        try {
            const loaded = await this.#transport.loadOwner(share.shareId);
            if (loaded === undefined) {
                await this.#transport.createOwner({
                    ownerPeerId: share.ownerPeerId,
                    shareId: share.shareId,
                });
            }
            // Ended grants are deliberately not replayed. Murmur's own durable state
            // already records every removal, and asking it to revoke a grant it has
            // already ended fails; worse, a revocation names only the peer, so replaying
            // an old epoch would remove the membership that same friend holds today.
            const grants = activeGrants(share);
            if (grants.length > 0) await this.#transport.inviteMany(grants);
            await this.#transport.retry(share.shareId);
            await this.publish(share.shareId);
            this.#store.setShareHealth(share.shareId, "active");
        } catch (error: unknown) {
            this.#store.setShareHealth(share.shareId, "degraded");
            throw error;
        }
    }

    #allKnownGrants(share: SessionShareRecord): SessionShareTransportGrant[] {
        const grants = [
            ...share.members.map(memberGrant),
            ...this.#store.queryEndedGrants(share.shareId),
        ];
        return [
            ...new Map(
                grants.map((grant) => [
                    `${grant.shareMemberId}\u0000${String(grant.grantEpoch)}`,
                    grant,
                ]),
            ).values(),
        ];
    }

    async #handleOwnerEvent(event: unknown): Promise<void> {
        if (!Value.Check(sessionShareTransportOwnerEventSchema, event)) {
            throw new Error("The session-share owner transport event is invalid.");
        }
        if (event.type === "transport_failed") {
            // Only the share whose transport failed is affected; degrading the others would
            // report an outage none of them is having. An unrecoverable failure means Murmur
            // has already retired the group, so the share is stopped rather than left
            // degraded forever against state that no longer exists.
            if (event.recoverable) {
                this.#store.setShareHealth(event.shareId, "degraded");
                return;
            }
            // Murmur already deleted this group's rows, so no retry can revive the share.
            // Recording it as stopped is the honest end state; left degraded, recovery
            // would retry forever against owner state that no longer exists.
            this.#store.stopShare(event.shareId);
            this.#ownerSubscriptions.get(event.shareId)?.();
            this.#ownerSubscriptions.delete(event.shareId);
            return;
        }
        if (event.type === "transport_recovered") return;
        const { post, senderPeerId } = event;
        if (senderPeerId !== post.grant.murmurPeerId) {
            throw new SessionShareUnauthorizedPostError(
                "A friend message sender does not match its authenticated grant.",
            );
        }
        // The label a friend's message is rendered under is the one the owner registered
        // when inviting them, never a name the network supplied.
        const member = this.#store
            .queryShare(post.grant.shareId)
            ?.members.find((candidate) => candidate.shareMemberId === post.grant.shareMemberId);
        if (member === undefined) {
            throw new SessionShareUnauthorizedPostError(
                "A friend message names a member this share does not have.",
            );
        }
        const friendAuthor: FriendAuthor = {
            displayName: member.displayName,
            grantEpoch: post.grant.grantEpoch,
            kind: "friend",
            murmurPeerId: senderPeerId,
            shareId: post.grant.shareId,
            shareMemberId: post.grant.shareMemberId,
        };
        const message: UserMessage = {
            blocks: [{ text: post.text, type: "text" }],
            contextOnly: true,
            friendAuthor,
            id: this.#idFactory(),
            role: "user",
        };
        const accepted = this.#store.acceptFriendMessage(post, senderPeerId, message);
        if (accepted.status === "accepted") {
            await this.#deliverFriendMessage(accepted.ownerSessionId, accepted.message, {
                createdAt: accepted.createdAt,
                event: accepted.event,
                overflowedMessageIds: accepted.overflowedMessageIds,
                position: accepted.position,
            });
        }
    }

    #handleMemberEvent(event: unknown): void {
        if (!Value.Check(sessionShareTransportMemberEventSchema, event)) {
            throw new Error("The session-share member transport event is invalid.");
        }
        if (event.type === "transport_failed" || event.type === "transport_recovered") return;
        if (event.type === "entries_appended") {
            assertPageBounds(event.entries);
            this.#store.appendReplicaEntries(event.grant, event.entries);
            return;
        }
        // The subscription goes either way: an end for a grant this replica has already
        // moved past is stale for the store but still retires that epoch's handler, and
        // keeping it would leak one handler per epoch for the daemon's lifetime.
        this.#store.endReplica(event.grant, event.reason);
        this.#memberSubscriptions.get(grantKey(event.grant))?.();
        this.#memberSubscriptions.delete(grantKey(event.grant));
    }

    #assertOpen(): void {
        if (this.#closed) throw new Error("The session sharing service is closed.");
    }
}

function activeGrants(share: SessionShareRecord): SessionShareTransportGrant[] {
    return share.members.filter((member) => member.state === "active").map(memberGrant);
}

function memberGrant(member: SessionShareMemberRecord): SessionShareTransportGrant {
    return {
        grantEpoch: member.grantEpoch,
        murmurPeerId: member.murmurPeerId,
        shareId: member.shareId,
        shareMemberId: member.shareMemberId,
    };
}

function grantKey(grant: SessionShareTransportGrant): string {
    return `${grant.shareId}\u0000${grant.shareMemberId}\u0000${String(grant.grantEpoch)}`;
}

function assertPageBounds(entries: readonly SessionShareOpaqueEntry[]): void {
    if (entries.length === 0 || entries.length > MAX_PAGE_COUNT) {
        throw new Error("A session share page must contain 1 to 100 entries.");
    }
    const bytes = entries.reduce(
        (total, entry) => total + Buffer.byteLength(entry.canonicalJson, "utf8"),
        0,
    );
    // A single complete entry may exceed the wire page. SessionShareTransport owns deterministic
    // fragmentation/reassembly for that entry; multi-entry batches remain wire-page bounded.
    if (entries.length > 1 && bytes > MAX_PAGE_BYTES) {
        throw new Error("A session share page exceeds 256 KiB.");
    }
}
