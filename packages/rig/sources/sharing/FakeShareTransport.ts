import type { SharedSessionEphemeralChannel } from "@slopus/murmur/sharedSession";

import type {
    ShareOpaqueEntry,
    ShareTransport,
    ShareTransportGrant,
    ShareTransportMemberEvent,
    ShareTransportMemberPost,
    ShareTransportOwner,
    ShareTransportOwnerEvent,
} from "./ShareTransport.js";

type FailureOperation =
    | "append"
    | "create"
    | "invite"
    | "join"
    | "load"
    | "post"
    | "retry"
    | "revoke"
    | "stop";

interface FakeShare {
    readonly entries: ShareOpaqueEntry[];
    readonly grants: Map<string, ShareTransportGrant>;
    readonly owner: ShareTransportOwner;
    stopped: boolean;
}

interface QueuedDelivery {
    readonly deliver: () => void | Promise<void>;
    readonly kind: "member" | "owner";
    readonly shareId: string;
}

function grantKey(grant: ShareTransportGrant): string {
    return `${grant.shareId}\u0000${grant.shareMemberId}\u0000${String(grant.grantEpoch)}`;
}

export class FakeShareTransport implements ShareTransport {
    /**
     * Peer channels a test wired up, keyed `owner\u0000<shareId>` or
     * `member\u0000<shareId>\u0000<shareMemberId>`.
     *
     * Public so a test supplies its own in-memory pair. A fake that invented a
     * channel would let a test pass while the real transport had none, which is
     * the one thing a fake here must never do.
     */
    readonly ephemeralChannels = new Map<string, SharedSessionEphemeralChannel>();
    readonly #failures = new Map<FailureOperation, Error[]>();
    readonly #memberHandlers = new Map<
        string,
        Set<(event: ShareTransportMemberEvent) => void | Promise<void>>
    >();
    readonly #ownerHandlers = new Map<
        string,
        Set<(event: ShareTransportOwnerEvent) => void | Promise<void>>
    >();
    readonly #queue: QueuedDelivery[] = [];
    readonly #shares = new Map<string, FakeShare>();
    #autoDeliver = true;
    #dropNext = 0;
    #duplicateNext = 0;
    #maximumPhysicalPageBytes = 0;

    setAutoDeliver(value: boolean): void {
        this.#autoDeliver = value;
    }

    failNext(operation: FailureOperation, error = new Error(`Fake ${operation} failure`)): void {
        const failures = this.#failures.get(operation) ?? [];
        failures.push(error);
        this.#failures.set(operation, failures);
    }

    dropNext(count = 1): void {
        this.#dropNext += count;
    }

    duplicateNext(count = 1): void {
        this.#duplicateNext += count;
    }

    queuedDeliveries(): number {
        return this.#queue.length;
    }

    maximumPhysicalPageBytes(): number {
        return this.#maximumPhysicalPageBytes;
    }

    async flushNext(index = 0): Promise<void> {
        const [queued] = this.#queue.splice(index, 1);
        if (queued !== undefined) await queued.deliver();
    }

    async flushAll(options: { reverse?: boolean } = {}): Promise<void> {
        if (options.reverse === true) this.#queue.reverse();
        while (this.#queue.length > 0) await this.flushNext();
    }

    reset(): void {
        this.#queue.length = 0;
        this.#ownerHandlers.clear();
        this.#memberHandlers.clear();
    }

    async createOwner(owner: ShareTransportOwner): Promise<void> {
        this.#throwFailure("create");
        const existing = this.#shares.get(owner.shareId);
        if (existing !== undefined) {
            if (existing.owner.ownerPeerId !== owner.ownerPeerId) {
                throw new Error("A fake share cannot change owners.");
            }
            return;
        }
        this.#shares.set(owner.shareId, {
            entries: [],
            grants: new Map(),
            owner,
            stopped: false,
        });
    }

    async loadOwner(shareId: string): Promise<ShareTransportOwner | undefined> {
        this.#throwFailure("load");
        return this.#shares.get(shareId)?.owner;
    }

    async appendOwnerEntries(shareId: string, entries: readonly ShareOpaqueEntry[]): Promise<void> {
        this.#throwFailure("append");
        if (entries.length === 0 || entries.length > 100) {
            throw new Error("Fake transport pages must contain 1 to 100 entries.");
        }
        // This semantic API accepts a complete opaque entry. A real adapter and this fake both
        // fragment oversized entries into bounded physical pages before transport.
        let physicalPageBytes = 0;
        for (const entry of entries) {
            let remaining = Buffer.byteLength(entry.canonicalJson, "utf8");
            while (remaining > 0) {
                const chunkBytes = Math.min(remaining, 256 * 1024);
                this.#maximumPhysicalPageBytes = Math.max(
                    this.#maximumPhysicalPageBytes,
                    chunkBytes,
                );
                remaining -= chunkBytes;
                physicalPageBytes = chunkBytes === 256 * 1024 ? 0 : chunkBytes;
            }
        }
        if (
            entries.length > 1 &&
            entries.reduce(
                (total, entry) => total + Buffer.byteLength(entry.canonicalJson, "utf8"),
                0,
            ) >
                256 * 1024
        ) {
            throw new Error("Fake transport batches cannot exceed 256 KiB.");
        }
        this.#maximumPhysicalPageBytes = Math.max(
            this.#maximumPhysicalPageBytes,
            physicalPageBytes,
        );
        const share = this.#requireShare(shareId);
        if (share.stopped) throw new Error("A stopped fake share cannot append entries.");
        const existing = new Set(share.entries.map((entry) => entry.shareEventId));
        for (const entry of entries) {
            if (!existing.has(entry.shareEventId)) {
                share.entries.push(structuredClone(entry));
                existing.add(entry.shareEventId);
            }
        }
        share.entries.sort((left, right) => left.shareSequence - right.shareSequence);
        for (const grant of share.grants.values()) {
            await this.#enqueueMember(grant, {
                entries: entries.map((entry) => structuredClone(entry)),
                grant,
                type: "entries_appended",
            });
        }
    }

    async inviteMany(grants: readonly ShareTransportGrant[]): Promise<void> {
        this.#throwFailure("invite");
        if (grants.length === 0) throw new Error("An invite batch cannot be empty.");
        for (const grant of grants) this.#saveGrant(grant);
        for (const grant of grants) await this.#replay(grant);
    }

    async invite(grant: ShareTransportGrant): Promise<void> {
        this.#throwFailure("invite");
        this.#saveGrant(grant);
        await this.#replay(grant);
    }

    async revoke(grant: ShareTransportGrant): Promise<void> {
        this.#throwFailure("revoke");
        const share = this.#requireShare(grant.shareId);
        // The real transport removes a Murmur peer, not one epoch of it, so a revocation
        // takes out whichever grant that peer currently holds and does nothing when it
        // holds none. Modelling it any other way hides the divergence from the real one.
        const current = [...share.grants.values()].find(
            (candidate) => candidate.murmurPeerId === grant.murmurPeerId,
        );
        if (current === undefined) return;
        share.grants.delete(grantKey(current));
        await this.#enqueueMember(current, { grant: current, reason: "revoked", type: "ended" });
    }

    /** Grants this share currently holds, for asserting who can still decrypt it. */
    grantsFor(shareId: string): readonly ShareTransportGrant[] {
        return [...(this.#shares.get(shareId)?.grants.values() ?? [])];
    }

    async stop(shareId: string, grants: readonly ShareTransportGrant[]): Promise<void> {
        this.#throwFailure("stop");
        const share = this.#requireShare(shareId);
        share.stopped = true;
        for (const grant of grants) {
            share.grants.delete(grantKey(grant));
            await this.#enqueueMember(grant, { grant, reason: "stopped", type: "ended" });
        }
    }

    handleOwnerEvents(
        shareId: string,
        callback: (event: ShareTransportOwnerEvent) => void | Promise<void>,
    ): () => void {
        const handlers = this.#ownerHandlers.get(shareId) ?? new Set();
        handlers.add(callback);
        this.#ownerHandlers.set(shareId, handlers);
        return () => {
            handlers.delete(callback);
            if (handlers.size === 0) this.#ownerHandlers.delete(shareId);
        };
    }

    async joinMember(grant: ShareTransportGrant): Promise<void> {
        this.#throwFailure("join");
        const saved = this.#requireShare(grant.shareId).grants.get(grantKey(grant));
        if (saved === undefined) throw new Error("The fake grant is not active.");
    }

    async loadMember(grant: ShareTransportGrant): Promise<ShareTransportGrant | undefined> {
        this.#throwFailure("load");
        return this.#shares.get(grant.shareId)?.grants.get(grantKey(grant));
    }

    async postMember(post: ShareTransportMemberPost): Promise<void> {
        this.#throwFailure("post");
        const grant = this.#requireShare(post.grant.shareId).grants.get(grantKey(post.grant));
        if (grant === undefined || grant.murmurPeerId !== post.grant.murmurPeerId) {
            throw new Error("The fake member post is not authenticated by an active grant.");
        }
        await this.#enqueueOwner(post.grant.shareId, {
            post: structuredClone(post),
            senderPeerId: post.grant.murmurPeerId,
            type: "member_posted",
        });
    }

    handleMemberEvents(
        grant: ShareTransportGrant,
        callback: (event: ShareTransportMemberEvent) => void | Promise<void>,
    ): () => void {
        const key = grantKey(grant);
        const handlers = this.#memberHandlers.get(key) ?? new Set();
        handlers.add(callback);
        this.#memberHandlers.set(key, handlers);
        return () => {
            handlers.delete(callback);
            if (handlers.size === 0) this.#memberHandlers.delete(key);
        };
    }

    async sendMemberControl(
        grant: ShareTransportGrant,
        controlId: string,
        payload: unknown,
    ): Promise<void> {
        this.#throwFailure("post");
        this.#requireShare(grant.shareId);
        await this.#enqueueOwner(grant.shareId, {
            control: {
                authenticatedPeerId: grant.murmurPeerId,
                controlId,
                grantEpoch: grant.grantEpoch,
                payload,
                shareId: grant.shareId,
                shareMemberId: grant.shareMemberId,
                timestamp: 0,
            },
            type: "member_control",
        });
    }

    openOwnerEphemeralChannel(shareId: string): SharedSessionEphemeralChannel | undefined {
        return this.ephemeralChannels.get(`owner\u0000${shareId}`);
    }

    openMemberEphemeralChannel(
        grant: ShareTransportGrant,
    ): SharedSessionEphemeralChannel | undefined {
        return this.ephemeralChannels.get(
            `member\u0000${grant.shareId}\u0000${grant.shareMemberId}`,
        );
    }

    async retry(shareId: string): Promise<boolean> {
        this.#throwFailure("retry");
        this.#requireShare(shareId);
        await this.#enqueueOwner(shareId, { shareId, type: "transport_recovered" });
        return false;
    }

    async #replay(grant: ShareTransportGrant): Promise<void> {
        const entries = this.#requireShare(grant.shareId).entries;
        for (let index = 0; index < entries.length; index += 100) {
            await this.#enqueueMember(grant, {
                entries: entries.slice(index, index + 100).map((entry) => structuredClone(entry)),
                grant,
                type: "entries_appended",
            });
        }
    }

    #saveGrant(grant: ShareTransportGrant): void {
        const share = this.#requireShare(grant.shareId);
        if (share.stopped) throw new Error("A stopped fake share cannot invite members.");
        share.grants.set(grantKey(grant), structuredClone(grant));
    }

    async #enqueueOwner(shareId: string, event: ShareTransportOwnerEvent): Promise<void> {
        await this.#enqueue({
            deliver: async () => {
                for (const handler of this.#ownerHandlers.get(shareId) ?? []) {
                    await handler(structuredClone(event));
                }
            },
            kind: "owner",
            shareId,
        });
    }

    async #enqueueMember(
        grant: ShareTransportGrant,
        event: ShareTransportMemberEvent,
    ): Promise<void> {
        await this.#enqueue({
            deliver: async () => {
                for (const handler of this.#memberHandlers.get(grantKey(grant)) ?? []) {
                    await handler(structuredClone(event));
                }
            },
            kind: "member",
            shareId: grant.shareId,
        });
    }

    async #enqueue(delivery: QueuedDelivery): Promise<void> {
        if (this.#dropNext > 0) {
            this.#dropNext -= 1;
            return;
        }
        const copies = this.#duplicateNext > 0 ? 2 : 1;
        if (this.#duplicateNext > 0) this.#duplicateNext -= 1;
        for (let index = 0; index < copies; index += 1) {
            if (this.#autoDeliver) await delivery.deliver();
            else this.#queue.push(delivery);
        }
    }

    #requireShare(shareId: string): FakeShare {
        const share = this.#shares.get(shareId);
        if (share === undefined) throw new Error(`Unknown fake share '${shareId}'.`);
        return share;
    }

    #throwFailure(operation: FailureOperation): void {
        const failures = this.#failures.get(operation);
        const failure = failures?.shift();
        if (failures?.length === 0) this.#failures.delete(operation);
        if (failure !== undefined) throw failure;
    }
}
