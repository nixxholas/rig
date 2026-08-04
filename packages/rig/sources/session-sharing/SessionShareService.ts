import { createId } from "@paralleldrive/cuid2";
import { Value } from "@sinclair/typebox/value";

import type { UserMessage } from "../agent/types.js";
import { asyncQueue, type AsyncQueue } from "../concurrency/index.js";
import { rethrowDatabaseFailure } from "../persistence/rethrowDatabaseFailure.js";
import type { SessionShareReplicaEndedReason } from "../persistence/session-sharing/types.js";
import { ShareUnauthorizedPostError } from "../sharing/ShareUnauthorizedPostError.js";
import type { SharedToolOutput } from "./SharedToolOutput.js";
import type { FriendAuthor } from "./FriendAuthor.js";
import type { PeerCapability } from "./peer-access/index.js";
import type {
    ShareOpaqueEntry,
    ShareTransport,
    ShareTransportGrant,
    ShareTransportMemberControl,
    ShareTransportMemberPost,
} from "../sharing/ShareTransport.js";
import {
    shareTransportMemberEventSchema,
    shareTransportOwnerEventSchema,
} from "../sharing/ShareTransport.js";

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
    /** How much of each tool's work this share replicates. */
    readonly toolOutput: SharedToolOutput;
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

export interface SessionShareReplicaRecord {
    readonly grant: ShareTransportGrant;
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
        toolOutput: SharedToolOutput;
    }): SessionShareRecord;
    queryShare(shareId: string): SessionShareRecord | undefined;
    queryActiveShareForSession(ownerSessionId: string): SessionShareRecord | undefined;
    queryRecoverableShares(): readonly SessionShareRecord[];
    queryEndedGrants(shareId: string): readonly ShareTransportGrant[];
    addMember(input: {
        displayName: string;
        murmurPeerId: string;
        shareId: string;
        shareMemberId: string;
    }): SessionShareMemberRecord;
    revokeMember(shareId: string, shareMemberId: string): SessionShareMemberRecord;
    stopShare(shareId: string): SessionShareRecord;
    setIncludeFriendMessages(shareId: string, include: boolean): SessionShareRecord;
    setToolOutput(shareId: string, toolOutput: SharedToolOutput): SessionShareRecord;
    /** Replace a member's capability set. A full set, never a delta. */
    setMemberCapabilities(input: {
        capabilities: readonly PeerCapability[];
        shareId: string;
        shareMemberId: string;
    }): readonly PeerCapability[];
    setShareHealth(shareId: string, state: "active" | "degraded"): void;
    acceptFriendMessage(
        post: ShareTransportMemberPost,
        senderPeerId: string,
        message: UserMessage,
    ): SessionShareAcceptedFriendMessage | SessionShareDuplicateFriendMessage;
    tailOutbox(shareId: string): number;
    queryOutboxPage(
        shareId: string,
        limits: { maxBytes: number; maxItems: number },
    ): readonly ShareOpaqueEntry[];
    acknowledgeOutbox(shareId: string, throughShareSequence: number): void;
    saveReplica(replica: SessionShareReplicaRecord): void;
    appendReplicaEntries(grant: ShareTransportGrant, entries: readonly ShareOpaqueEntry[]): void;
    endReplica(
        grant: ShareTransportGrant,
        reason: SessionShareReplicaEndedReason,
    ): "ended" | "stale";
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
    /**
     * Live peer channels, when this daemon has any.
     *
     * Optional because the capability model is additive: a build with no peer
     * access at all still revokes correctly, it simply has nothing to close.
     */
    readonly peerAccess?: SessionSharePeerAccess;
    /**
     * Handles one authenticated structured request from a member.
     *
     * Optional, and its absence means this daemon accepts no peer requests at
     * all: the frame is dropped rather than interpreted, which is the right
     * default for a build with no peer access wired up.
     */
    readonly handleMemberControl?: (control: ShareTransportMemberControl) => void;
    /** Told when a member's capability set changes, for the light stream event. */
    readonly publishCapabilities?: (change: SessionShareCapabilityChange) => void;
    readonly store: SessionShareCoreStore;
    readonly transport: ShareTransport;
}

export interface SessionSharePeerAccess {
    /** Close every peer channel for a member, or for a whole share. Synchronous. */
    invalidate(input: { shareId: string; shareMemberId?: string }): number;
}

export interface SessionShareCapabilityChange {
    readonly capabilities: readonly PeerCapability[];
    readonly shareId: string;
    readonly shareMemberId: string;
}

export class SessionShareService {
    readonly #deliverFriendMessage: SessionShareServiceOptions["deliverFriendMessage"];
    readonly #idFactory: () => string;
    readonly #handleMemberControl: SessionShareServiceOptions["handleMemberControl"];
    readonly #peerAccess: SessionSharePeerAccess | undefined;
    readonly #publishCapabilities: SessionShareServiceOptions["publishCapabilities"];
    readonly #ownerSubscriptions = new Map<string, () => void>();
    readonly #memberSubscriptions = new Map<string, () => void>();
    readonly #pendingEnds: ShareTransportGrant[] = [];
    readonly #publishQueues = new Map<string, AsyncQueue>();
    readonly #publishRequested = new Set<string>();
    readonly #store: SessionShareCoreStore;
    readonly #transport: ShareTransport;
    #closed = false;

    constructor(options: SessionShareServiceOptions) {
        this.#deliverFriendMessage = options.deliverFriendMessage;
        this.#idFactory = options.idFactory ?? createId;
        this.#handleMemberControl = options.handleMemberControl;
        this.#peerAccess = options.peerAccess;
        this.#publishCapabilities = options.publishCapabilities;
        this.#store = options.store;
        this.#transport = options.transport;
    }

    async create(input: {
        friends: readonly SessionShareFriendInput[];
        includeFriendMessagesInModel: boolean;
        ownerPeerId: string;
        ownerSessionId: string;
        toolOutput: SharedToolOutput;
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
        // Revocation is ordered, and the order is the security property:
        //
        // 1. `revokeMember` commits. It marks the member revoked, bumps the grant
        //    epoch, and marks every capability row revoked in the same transaction,
        //    so nothing durable can still resolve.
        // 2. Synchronously after that commit, in memory, every peer channel this
        //    member holds is closed and every pending request is refused. This step
        //    is what actually ends the access, and it needs no network at all.
        // 3. Only then, best effort, the transport is told and the change is
        //    broadcast. If that fails the member's own UI keeps a stale label on a
        //    channel that is already dead, which is the harmless failure.
        const member = this.#store.revokeMember(shareId, shareMemberId);
        this.#peerAccess?.invalidate({ shareId, shareMemberId });
        this.#broadcastCapabilities(shareId, shareMemberId, []);
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
        // Same three ordered steps as `revoke`, for every member at once:
        // `stopShare` marks the share and its capability rows in one committed
        // transaction, then the in-memory channels close before any network call.
        const share = this.#store.stopShare(shareId);
        this.#peerAccess?.invalidate({ shareId });
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

    setToolOutput(shareId: string, toolOutput: SharedToolOutput): SessionShareRecord {
        this.#assertOpen();
        return this.#store.setToolOutput(shareId, toolOutput);
    }

    /**
     * Replace one member's capability set, then apply the change in memory.
     *
     * Same ordering as a revoke, for the same reason: the durable set is the
     * only authority, so it commits first, and every channel authorized under
     * the previous set is closed synchronously afterwards. A capability that was
     * dropped is therefore dead before this returns, whether or not the network
     * ever hears about it.
     */
    async setMemberCapabilities(input: {
        capabilities: readonly PeerCapability[];
        shareId: string;
        shareMemberId: string;
    }): Promise<readonly PeerCapability[]> {
        this.#assertOpen();
        const granted = this.#store.setMemberCapabilities(input);
        this.#peerAccess?.invalidate({
            shareId: input.shareId,
            shareMemberId: input.shareMemberId,
        });
        this.#broadcastCapabilities(input.shareId, input.shareMemberId, granted);
        return granted;
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
                    // A revocation Rig recorded but the transport never accepted leaves the
                    // member decrypting, so it is repaired before anything more is published
                    // — and again before each page, since one drain round is unbounded on a
                    // busy session. A share with nothing to repair pays one indexed read.
                    await this.#repairRevocations(shareId);
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
                        await this.#repairRevocations(shareId);
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
    observeReplica(grant: ShareTransportGrant): void {
        this.#assertOpen();
        const key = grantKey(grant);
        this.#memberSubscriptions.get(key)?.();
        this.#memberSubscriptions.set(
            key,
            this.#transport.handleMemberEvents(grant, (event) => this.#handleMemberEvent(event)),
        );
    }

    async post(post: ShareTransportMemberPost): Promise<void> {
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
        this.#pendingEnds.length = 0;
    }

    /**
     * Replay a revocation the transport never accepted.
     *
     * Only a peer Rig no longer grants access to is replayed, so a friend who was
     * invited back is never removed by their own stale epoch, and the transport skips
     * anyone Murmur has already removed — so a share with nothing to repair pays for
     * one indexed read.
     */
    async #repairRevocations(shareId: string): Promise<void> {
        const ended = this.#store.queryEndedGrants(shareId);
        if (ended.length === 0) return;
        const share = this.#store.queryShare(shareId);
        const active = new Set(
            share === undefined ? [] : activeGrants(share).map((grant) => grant.murmurPeerId),
        );
        for (const grant of ended) {
            if (!active.has(grant.murmurPeerId)) await this.#transport.revoke(grant);
        }
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

    #allKnownGrants(share: SessionShareRecord): ShareTransportGrant[] {
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
        if (!Value.Check(shareTransportOwnerEventSchema, event)) {
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
        if (event.type === "member_control") {
            // Control carries capability requests, which this service does not itself
            // act on: a peer channel is opened by the peer-access layer, against the
            // grant Murmur authenticated on the frame. Handing it to a callback keeps
            // that decision out of the transcript path entirely.
            this.#handleMemberControl?.(event.control);
            return;
        }
        const { post, senderPeerId } = event;
        if (senderPeerId !== post.grant.murmurPeerId) {
            throw new ShareUnauthorizedPostError(
                "A friend message sender does not match its authenticated grant.",
            );
        }
        // The label a friend's message is rendered under is the one the owner registered
        // when inviting them, never a name the network supplied.
        const member = this.#store
            .queryShare(post.grant.shareId)
            ?.members.find((candidate) => candidate.shareMemberId === post.grant.shareMemberId);
        if (member === undefined) {
            throw new ShareUnauthorizedPostError(
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
        if (!Value.Check(shareTransportMemberEventSchema, event)) {
            throw new Error("The session-share member transport event is invalid.");
        }
        if (event.type === "transport_failed" || event.type === "transport_recovered") return;
        if (event.type === "entries_appended") {
            assertPageBounds(event.entries);
            try {
                this.#store.appendReplicaEntries(event.grant, event.entries);
            } catch (error: unknown) {
                rethrowDatabaseFailure(error);
                // The owner sent an entry this replica cannot apply — a sequence already
                // held with different content, or a grant that is not the live one. The
                // replica's visible transcript stops at its first gap, so continuing would
                // silently freeze it while still reporting active. Ending it says so — but
                // this handler runs inside Murmur's own transaction, and retiring a replica
                // over an entry Murmur then rolls back would end it for something that
                // never landed. So the end is held until the caller commits.
                this.#pendingEnds.push(event.grant);
            }
            return;
        }
        this.#endReplica(event.grant, event.reason);
    }

    /**
     * Retire the replicas that failed to apply an entry in the transaction just committed.
     *
     * Called by the event router once the transport returns, which is the first moment
     * Murmur's transaction — the one the failure was observed inside — is durable.
     */
    flushReplicaEnds(): void {
        for (const grant of this.#pendingEnds.splice(0)) {
            this.#endReplica(grant, "unreadable");
        }
    }

    #endReplica(grant: ShareTransportGrant, reason: SessionShareReplicaEndedReason): void {
        // The subscription goes either way: an end for a grant this replica has already
        // moved past is stale for the store but still retires that epoch's handler, and
        // keeping it would leak one handler per epoch for the daemon's lifetime.
        this.#store.endReplica(grant, reason);
        this.#memberSubscriptions.get(grantKey(grant))?.();
        this.#memberSubscriptions.delete(grantKey(grant));
    }

    #broadcastCapabilities(
        shareId: string,
        shareMemberId: string,
        capabilities: readonly PeerCapability[],
    ): void {
        try {
            this.#publishCapabilities?.({ capabilities, shareId, shareMemberId });
        } catch {
            // Step 3 of the revocation ordering, and deliberately unable to fail the
            // revocation: the channels are already closed by the time this runs, so a
            // broadcast that does not land costs a stale label and nothing else.
        }
    }

    #assertOpen(): void {
        if (this.#closed) throw new Error("The session sharing service is closed.");
    }
}

function activeGrants(share: SessionShareRecord): ShareTransportGrant[] {
    return share.members.filter((member) => member.state === "active").map(memberGrant);
}

function memberGrant(member: SessionShareMemberRecord): ShareTransportGrant {
    return {
        grantEpoch: member.grantEpoch,
        murmurPeerId: member.murmurPeerId,
        shareId: member.shareId,
        shareMemberId: member.shareMemberId,
    };
}

function grantKey(grant: ShareTransportGrant): string {
    return `${grant.shareId}\u0000${grant.shareMemberId}\u0000${String(grant.grantEpoch)}`;
}

function assertPageBounds(entries: readonly ShareOpaqueEntry[]): void {
    if (entries.length === 0 || entries.length > MAX_PAGE_COUNT) {
        throw new Error("A session share page must contain 1 to 100 entries.");
    }
    const bytes = entries.reduce(
        (total, entry) => total + Buffer.byteLength(entry.canonicalJson, "utf8"),
        0,
    );
    // A single complete entry may exceed the wire page. ShareTransport owns deterministic
    // fragmentation/reassembly for that entry; multi-entry batches remain wire-page bounded.
    if (entries.length > 1 && bytes > MAX_PAGE_BYTES) {
        throw new Error("A session share page exceeds 256 KiB.");
    }
}
