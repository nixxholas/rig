import { createId } from "@paralleldrive/cuid2";
import { Value } from "@sinclair/typebox/value";

import { asyncQueue, type AsyncQueue } from "../concurrency/index.js";
import { rethrowDatabaseFailure } from "../persistence/rethrowDatabaseFailure.js";
import type {
    ScopeShareReplicaEndedReason,
    ScopeShareScopeKind,
} from "../persistence/scope-sharing/types.js";
import { createShareId } from "../sharing/shareId.js";
import type {
    ShareOpaqueEntry,
    ShareTransport,
    ShareTransportGrant,
} from "../sharing/ShareTransport.js";
import {
    shareTransportMemberEventSchema,
    shareTransportOwnerEventSchema,
} from "../sharing/ShareTransport.js";

const MAX_PAGE_COUNT = 100;
const MAX_PAGE_BYTES = 256 * 1024;

export type ScopeShareState = "active" | "degraded" | "stopped";
export type ScopeShareMemberState = "active" | "revoked" | "stopped";

export interface ScopeShareRecord {
    readonly members: readonly ScopeShareMemberRecord[];
    readonly ownerPeerId: string;
    readonly scopeId: string;
    readonly scopeKind: ScopeShareScopeKind;
    readonly shareId: string;
    readonly state: ScopeShareState;
}

export interface ScopeShareMemberRecord {
    readonly displayName: string;
    readonly grantEpoch: number;
    readonly murmurPeerId: string;
    readonly shareId: string;
    readonly shareMemberId: string;
    readonly state: ScopeShareMemberState;
}

export interface ScopeShareFriendInput {
    readonly displayName: string;
    readonly murmurPeerId: string;
}

export interface ScopeShareReplicaRecord {
    readonly grant: ShareTransportGrant;
    readonly memberCount: number;
    readonly ownerPeerId: string;
    readonly scopeKind: ScopeShareScopeKind;
    readonly state: "active" | "ended";
    readonly title: string;
}

/** The durable state the transport-facing half of scope sharing reads and writes. */
export interface ScopeShareCoreStore {
    createShare(input: {
        friends: readonly ScopeShareFriendInput[];
        ownerPeerId: string;
        scopeId: string;
        scopeKind: ScopeShareScopeKind;
        shareId: string;
    }): ScopeShareRecord;
    queryShare(shareId: string): ScopeShareRecord | undefined;
    queryActiveShareForScope(scope: {
        scopeId: string;
        scopeKind: ScopeShareScopeKind;
    }): ScopeShareRecord | undefined;
    queryRecoverableShares(): readonly ScopeShareRecord[];
    queryLiveSharesInProject(projectId: string): readonly ScopeShareRecord[];
    queryEndedGrants(shareId: string): readonly ShareTransportGrant[];
    addMember(input: {
        displayName: string;
        murmurPeerId: string;
        shareId: string;
        shareMemberId: string;
    }): ScopeShareMemberRecord;
    revokeMember(shareId: string, shareMemberId: string): ScopeShareMemberRecord;
    stopShare(shareId: string): ScopeShareRecord;
    setShareHealth(shareId: string, state: "active" | "degraded"): void;
    tailOutbox(shareId: string): number;
    queryOutboxPage(
        shareId: string,
        limits: { maxBytes: number; maxItems: number },
    ): readonly ShareOpaqueEntry[];
    acknowledgeOutbox(shareId: string, throughShareSequence: number): void;
    saveReplica(replica: ScopeShareReplicaRecord): void;
    appendReplicaEntries(grant: ShareTransportGrant, entries: readonly ShareOpaqueEntry[]): void;
    endReplica(grant: ShareTransportGrant, reason: ScopeShareReplicaEndedReason): "ended" | "stale";
}

export interface ScopeShareServiceOptions {
    readonly idFactory?: () => string;
    readonly shareIdFactory?: (scopeKind: ScopeShareScopeKind) => string;
    readonly store: ScopeShareCoreStore;
    readonly transport: ShareTransport;
}

/**
 * The owner and member halves of sharing a whole workspace or project.
 *
 * This is `SessionShareService`'s sibling rather than its generalization: the two
 * ride the same transport and the same runtime, but a scope share carries no
 * friend messages back into a conversation and a session share tails exactly one
 * session, so forcing one class to do both would obscure both.
 */
export class ScopeShareService {
    readonly #idFactory: () => string;
    readonly #memberSubscriptions = new Map<string, () => void>();
    readonly #ownerSubscriptions = new Map<string, () => void>();
    readonly #pendingEnds: ShareTransportGrant[] = [];
    readonly #publishQueues = new Map<string, AsyncQueue>();
    readonly #publishRequested = new Set<string>();
    readonly #shareIdFactory: (scopeKind: ScopeShareScopeKind) => string;
    readonly #store: ScopeShareCoreStore;
    readonly #transport: ShareTransport;
    #closed = false;

    constructor(options: ScopeShareServiceOptions) {
        this.#idFactory = options.idFactory ?? createId;
        this.#shareIdFactory = options.shareIdFactory ?? ((scopeKind) => createShareId(scopeKind));
        this.#store = options.store;
        this.#transport = options.transport;
    }

    async create(input: {
        friends: readonly ScopeShareFriendInput[];
        ownerPeerId: string;
        scopeId: string;
        scopeKind: ScopeShareScopeKind;
    }): Promise<ScopeShareRecord> {
        this.#assertOpen();
        if (input.friends.length === 0) {
            throw new Error("A shared workspace or project needs at least one friend.");
        }
        const existing = this.#store.queryActiveShareForScope(input);
        if (existing !== undefined) {
            await this.#recoverShare(existing);
            return this.#store.queryShare(existing.shareId) ?? existing;
        }
        const share = this.#store.createShare({
            ...input,
            shareId: this.#shareIdFactory(input.scopeKind),
        });
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
    }): Promise<ScopeShareMemberRecord> {
        this.#assertOpen();
        const member = this.#store.addMember({ ...input, shareMemberId: this.#idFactory() });
        try {
            await this.#transport.invite(memberGrant(member));
            this.#store.setShareHealth(input.shareId, "active");
        } catch (error: unknown) {
            this.#store.setShareHealth(input.shareId, "degraded");
            throw error;
        }
        return member;
    }

    async revoke(shareId: string, shareMemberId: string): Promise<ScopeShareMemberRecord> {
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

    /**
     * Stop a share, recording the stop even when the transport refuses it.
     *
     * The durable stop is the decision; the transport call is how it is carried out.
     * Recovery replays the retirement of a share it finds already stopped, so a
     * failure here never leaves a share that Rig believes is over still running.
     */
    async stop(shareId: string): Promise<ScopeShareRecord> {
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

    /** Archiving a workspace stops its share, and nothing else's. */
    async stopForArchivedWorkspace(workspaceId: string): Promise<ScopeShareRecord | undefined> {
        const share = this.#store.queryActiveShareForScope({
            scopeId: workspaceId,
            scopeKind: "workspace",
        });
        return share === undefined ? undefined : this.stop(share.shareId);
    }

    /**
     * Archiving a project stops the project's own share and every workspace share
     * beneath it, because none of those workspaces exists to replicate any more.
     */
    async stopForArchivedProject(projectId: string): Promise<readonly ScopeShareRecord[]> {
        const stopped: ScopeShareRecord[] = [];
        for (const share of this.#store.queryLiveSharesInProject(projectId)) {
            stopped.push(await this.stop(share.shareId));
        }
        return stopped;
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
            // publish() already recorded degraded health. Live wakeups are optional hints;
            // the durable cursors and outbox drive the later retry.
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
                    // busy scope. A share with nothing to repair pays one indexed read.
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

    async joinReplica(replica: ScopeShareReplicaRecord): Promise<void> {
        this.#assertOpen();
        const key = grantKey(replica.grant);
        this.#memberSubscriptions.get(key)?.();
        this.#memberSubscriptions.set(
            key,
            this.#transport.handleMemberEvents(replica.grant, (event) =>
                this.#handleMemberEvent(event),
            ),
        );
        try {
            // Saving the replica adopts the new grant epoch, which discards everything the
            // previous epoch replicated. A join that fails — a replayed invitation whose
            // one-use bundle is already spent, say — must not cost the member what it still
            // holds, so the durable epoch moves only after Murmur has accepted membership.
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
     * Retire the replicas that failed to apply an entry in the transaction just
     * committed. Called by the event router once the transport returns, which is the
     * first moment Murmur's own transaction is durable.
     */
    flushReplicaEnds(): void {
        for (const grant of this.#pendingEnds.splice(0)) this.#endReplica(grant, "unreadable");
    }

    /**
     * Replay a revocation the transport never accepted.
     *
     * Only a peer Rig no longer grants access to is replayed, so a friend who was
     * invited back is never removed by their own stale epoch.
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

    async #recoverShare(share: ScopeShareRecord): Promise<void> {
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

    #allKnownGrants(share: ScopeShareRecord): ShareTransportGrant[] {
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

    #handleOwnerEvent(event: unknown): void {
        if (!Value.Check(shareTransportOwnerEventSchema, event)) {
            throw new Error("The scope-share owner transport event is invalid.");
        }
        if (event.type === "transport_recovered") return;
        if (event.type !== "transport_failed") {
            // A shared scope has no member write path at all: nothing a member sends is
            // ever applied to the owner's workspace, project, or sessions.
            throw new Error("A shared scope does not accept member posts.");
        }
        // Only the share whose transport failed is affected; degrading the others would
        // report an outage none of them is having.
        if (event.recoverable) {
            this.#store.setShareHealth(event.shareId, "degraded");
            return;
        }
        // Murmur already deleted this group's rows, so no retry can revive the share.
        // Recording it as stopped is the honest end state; left degraded, recovery would
        // retry forever against owner state that no longer exists.
        this.#store.stopShare(event.shareId);
        this.#ownerSubscriptions.get(event.shareId)?.();
        this.#ownerSubscriptions.delete(event.shareId);
    }

    #handleMemberEvent(event: unknown): void {
        if (!Value.Check(shareTransportMemberEventSchema, event)) {
            throw new Error("The scope-share member transport event is invalid.");
        }
        if (event.type === "transport_failed" || event.type === "transport_recovered") return;
        if (event.type === "entries_appended") {
            assertPageBounds(event.entries);
            try {
                this.#store.appendReplicaEntries(event.grant, event.entries);
            } catch (error: unknown) {
                rethrowDatabaseFailure(error);
                // The owner sent an entry this replica cannot apply. Its visible history
                // stops at the first gap, so continuing would silently freeze it while
                // still reporting active. Ending it says so — but this handler runs inside
                // Murmur's own transaction, and retiring a replica over an entry Murmur
                // then rolls back would end it for something that never landed. So the end
                // is held until the caller commits.
                this.#pendingEnds.push(event.grant);
            }
            return;
        }
        this.#endReplica(event.grant, event.reason);
    }

    #endReplica(grant: ShareTransportGrant, reason: ScopeShareReplicaEndedReason): void {
        // The subscription goes either way: an end for a grant this replica has already
        // moved past is stale for the store but still retires that epoch's handler, and
        // keeping it would leak one handler per epoch for the daemon's lifetime.
        this.#store.endReplica(grant, reason);
        this.#memberSubscriptions.get(grantKey(grant))?.();
        this.#memberSubscriptions.delete(grantKey(grant));
    }

    #assertOpen(): void {
        if (this.#closed) throw new Error("The scope sharing service is closed.");
    }
}

function activeGrants(share: ScopeShareRecord): ShareTransportGrant[] {
    return share.members.filter((member) => member.state === "active").map(memberGrant);
}

function memberGrant(member: ScopeShareMemberRecord): ShareTransportGrant {
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
        throw new Error("A scope share page must contain 1 to 100 entries.");
    }
    const bytes = entries.reduce(
        (total, entry) => total + Buffer.byteLength(entry.canonicalJson, "utf8"),
        0,
    );
    // A single complete entry may exceed the wire page. ShareTransport owns deterministic
    // fragmentation and reassembly for that entry; multi-entry batches stay page bounded.
    if (entries.length > 1 && bytes > MAX_PAGE_BYTES) {
        throw new Error("A scope share page exceeds 256 KiB.");
    }
}
