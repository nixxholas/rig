import type { UserMessage } from "../../agent/types.js";
import type { SessionShareReplicaEndedReason } from "../../persistence/session-sharing/types.js";
import type { PeerCapability } from "../peer-access/index.js";
import type {
    SessionShareCoreStore,
    SessionShareFriendInput,
    SessionShareMemberRecord,
    SessionShareRecord,
    SessionShareReplicaRecord,
} from "../SessionShareService.js";
import type { SharedToolOutput } from "../SharedToolOutput.js";
import type {
    ShareOpaqueEntry,
    ShareTransportGrant,
    ShareTransportMemberPost,
} from "../../sharing/ShareTransport.js";

export class MemorySessionShareStore implements SessionShareCoreStore {
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
        toolOutput: SharedToolOutput;
    }): SessionShareRecord {
        this.operations.push(`create:${input.shareId}`);
        let memberIndex = 0;
        this.#share = {
            includeFriendMessagesInModel: input.includeFriendMessagesInModel,
            members: input.friends.map((friend) => ({
                ...friend,
                capabilities: [],
                grantEpoch: 1,
                shareId: input.shareId,
                shareMemberId: `member-${String(++memberIndex)}`,
                state: "active",
            })),
            ownerPeerId: input.ownerPeerId,
            ownerSessionId: input.ownerSessionId,
            shareId: input.shareId,
            state: "active",
            toolOutput: input.toolOutput,
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
            // A new epoch invalidates every capability grant written under the old one.
            existing.capabilities = [];
            return { ...existing };
        }
        const member: MutableMember = {
            ...input,
            capabilities: [],
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
        member.capabilities = [];
        return { ...member };
    }

    stopShare(shareId: string): SessionShareRecord {
        const share = this.#requireShare(shareId);
        share.state = "stopped";
        for (const member of share.members) {
            if (member.state === "active") this.endedGrants.push(toGrant(member));
            member.state = "stopped";
            member.capabilities = [];
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

    setToolOutput(shareId: string, toolOutput: SharedToolOutput): SessionShareRecord {
        this.#requireShare(shareId).toolOutput = toolOutput;
        return this.#cloneShare();
    }

    setMemberCapabilities(input: {
        capabilities: readonly PeerCapability[];
        shareId: string;
        shareMemberId: string;
    }): readonly PeerCapability[] {
        const member = this.#requireShare(input.shareId).members.find(
            (candidate) => candidate.shareMemberId === input.shareMemberId,
        );
        if (member === undefined) throw new Error("Unknown member");
        member.capabilities = [...input.capabilities];
        return [...member.capabilities];
    }

    /** The capabilities a member holds right now, for a test to assert none survive. */
    capabilitiesFor(shareId: string, shareMemberId: string): readonly PeerCapability[] {
        const member = this.#requireShare(shareId).members.find(
            (candidate) => candidate.shareMemberId === shareMemberId,
        );
        return member === undefined ? [] : [...member.capabilities];
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
    capabilities: PeerCapability[];
    displayName: string;
    grantEpoch: number;
    murmurPeerId: string;
    shareId: string;
    shareMemberId: string;
    state: "active" | "revoked" | "stopped";
}

interface MutableShare {
    includeFriendMessagesInModel: boolean;
    toolOutput: SharedToolOutput;
    members: MutableMember[];
    ownerPeerId: string;
    ownerSessionId: string;
    shareId: string;
    state: "active" | "degraded" | "stopped";
}

export function sequenceIds(...ids: string[]): () => string {
    return () => ids.shift()!;
}

export function toGrant(member: SessionShareMemberRecord): ShareTransportGrant {
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
