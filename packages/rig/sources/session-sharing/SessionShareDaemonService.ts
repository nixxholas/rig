import type {
    AddSessionShareMemberRequest,
    CreateSessionShareRequest,
    GetSessionShareHealthResponse,
    GetSessionSharePeerActivityResponse,
    GetSessionShareReplicaHistoryResponse,
    ListSessionShareReplicaCapabilitiesResponse,
    ListSessionShareReplicasResponse,
    PostSessionShareFriendMessageRequest,
    PostSessionShareFriendMessageResponse,
    RevokeSessionShareMemberRequest,
    SessionShareMember,
    SessionShareOfferableCapability,
    SessionShareOwnerResponse,
    SessionShareReplica,
    SetSessionShareFriendMessagesRequest,
    SetSessionShareMemberCapabilitiesRequest,
    SetSessionShareToolOutputRequest,
    StopSessionShareRequest,
} from "../protocol/index.js";
import type {
    SessionShareCapabilityRecord,
    SessionShareMemberRecord as StoredSessionShareMember,
    SessionSharePeerActionRecord,
    SessionShareReplicaRecord,
} from "../persistence/session-sharing/types.js";
import {
    describePeerActivityEntry,
    describePeerCapabilities,
    type PeerCapability,
} from "./peer-access/index.js";
import type { SessionShareServiceContract } from "./SessionShareServiceContract.js";
import type { SessionShareRecord, SessionShareService } from "./SessionShareService.js";
import { describeSharedToolOutput, DEFAULT_SHARED_TOOL_OUTPUT } from "./SharedToolOutput.js";

const MAX_HISTORY_PAGE = 100;

/**
 * Durable state the daemon service reads directly rather than through the
 * transport-facing core store.
 */
export interface SessionShareDaemonStore {
    queryShare(shareId: string): SessionShareRecord | undefined;
    queryActiveShareForSession(ownerSessionId: string): SessionShareRecord | undefined;
    queryPendingBytes(shareId: string): { pendingBytes: number; pendingEntries: number };
    queryReplicas(): readonly SessionShareReplicaRecord[];
    queryReplica(shareId: string): SessionShareReplicaRecord | undefined;
    queryReplicaHistory(
        shareId: string,
        afterSequence: number,
    ): {
        complete: boolean;
        entries: readonly {
            canonicalJson: string;
            createdAt: number;
            sequence: number;
            shareEventId: string;
        }[];
    };
    queryMembers(shareId: string): readonly StoredSessionShareMember[];
    /** Active capability rows for a share, already filtered to current epochs. */
    queryMemberCapabilities(shareId: string): readonly SessionShareCapabilityRecord[];
    queryPeerActions(
        shareId: string,
        afterSeq: number,
    ): { complete: boolean; entries: readonly SessionSharePeerActionRecord[] };
}

export interface SessionShareDaemonServiceOptions {
    /** Murmur peer ID of the local account, or `undefined` while it has none. */
    readonly localPeerId: () => Promise<string | undefined>;
    readonly now?: () => number;
    /**
     * What this session's project could offer a peer at all.
     *
     * Resolved per request rather than cached, because a project gaining or
     * losing its container environment has to change the answer immediately.
     */
    readonly offerableCapabilities: (
        ownerSessionId: string,
    ) => readonly SessionShareOfferableCapability[];
    readonly service: SessionShareService;
    readonly store: SessionShareDaemonStore;
}

/**
 * The daemon's API boundary for session sharing.
 *
 * Every owner-side route resolves the share from its session before touching
 * the transport, so a client only ever names the session it is looking at.
 */
export class SessionShareDaemonService implements SessionShareServiceContract {
    readonly #localPeerId: SessionShareDaemonServiceOptions["localPeerId"];
    readonly #now: () => number;
    readonly #offerableCapabilities: SessionShareDaemonServiceOptions["offerableCapabilities"];
    readonly #service: SessionShareService;
    readonly #store: SessionShareDaemonStore;

    constructor(options: SessionShareDaemonServiceOptions) {
        this.#localPeerId = options.localPeerId;
        this.#now = options.now ?? Date.now;
        this.#offerableCapabilities = options.offerableCapabilities;
        this.#service = options.service;
        this.#store = options.store;
    }

    getOwner(sessionId: string): SessionShareOwnerResponse | undefined {
        const share = this.#store.queryActiveShareForSession(sessionId);
        return share === undefined ? undefined : this.#ownerResponse(share.shareId);
    }

    async create(
        sessionId: string,
        request: CreateSessionShareRequest,
    ): Promise<SessionShareOwnerResponse> {
        const ownerPeerId = await this.#localPeerId();
        if (ownerPeerId === undefined) {
            throw new Error("Set up a Murmur account before sharing a session.");
        }
        const share = await this.#service.create({
            friends: request.friends.map((friend) => ({
                displayName: friend.displayName,
                murmurPeerId: friend.peerId,
            })),
            includeFriendMessagesInModel: request.includeFriendMessagesInModel,
            ownerPeerId,
            ownerSessionId: sessionId,
            // A request that says nothing about tool output is asking for none.
            toolOutput: request.toolOutput ?? DEFAULT_SHARED_TOOL_OUTPUT,
        });
        return this.#ownerResponse(share.shareId);
    }

    async add(
        sessionId: string,
        request: AddSessionShareMemberRequest,
    ): Promise<SessionShareOwnerResponse> {
        const shareId = this.#requireShareId(sessionId);
        await this.#service.add({
            displayName: request.friend.displayName,
            murmurPeerId: request.friend.peerId,
            shareId,
        });
        return this.#ownerResponse(shareId);
    }

    async revoke(
        sessionId: string,
        shareMemberId: string,
        _request: RevokeSessionShareMemberRequest,
    ): Promise<SessionShareOwnerResponse> {
        const shareId = this.#requireShareId(sessionId);
        await this.#service.revoke(shareId, shareMemberId);
        return this.#ownerResponse(shareId);
    }

    async stop(
        sessionId: string,
        _request: StopSessionShareRequest,
    ): Promise<SessionShareOwnerResponse> {
        const shareId = this.#requireShareId(sessionId);
        await this.#service.stop(shareId);
        return this.#ownerResponse(shareId);
    }

    async stopForArchivedSession(sessionId: string): Promise<void> {
        await this.#service.stopForArchivedSession(sessionId);
    }

    async setFriendMessages(
        sessionId: string,
        request: SetSessionShareFriendMessagesRequest,
    ): Promise<SessionShareOwnerResponse> {
        const shareId = this.#requireShareId(sessionId);
        this.#service.toggle(shareId, request.includeFriendMessagesInModel);
        return this.#ownerResponse(shareId);
    }

    async setToolOutput(
        sessionId: string,
        request: SetSessionShareToolOutputRequest,
    ): Promise<SessionShareOwnerResponse> {
        const shareId = this.#requireShareId(sessionId);
        this.#service.setToolOutput(shareId, request.toolOutput);
        return this.#ownerResponse(shareId);
    }

    async setMemberCapabilities(
        sessionId: string,
        shareMemberId: string,
        request: SetSessionShareMemberCapabilitiesRequest,
    ): Promise<SessionShareOwnerResponse> {
        const shareId = this.#requireShareId(sessionId);
        // A capability the project cannot confine is refused here rather than
        // stored and then quietly ignored at use time. Failing closed is only
        // honest if the owner is told at the moment they ask.
        const offerable = new Map(
            this.#offerableCapabilities(sessionId).map((entry) => [entry.capability, entry]),
        );
        for (const capability of request.capabilities) {
            const entry = offerable.get(capability);
            if (entry === undefined || !entry.offerable) {
                throw new Error(
                    entry?.unavailableReason ??
                        "This session cannot offer that permission to anybody.",
                );
            }
        }
        await this.#service.setMemberCapabilities({
            capabilities: request.capabilities,
            shareId,
            shareMemberId,
        });
        return this.#ownerResponse(shareId);
    }

    peerActivity(
        sessionId: string,
        after?: string,
    ): GetSessionSharePeerActivityResponse | undefined {
        const share = this.#store.queryActiveShareForSession(sessionId);
        if (share === undefined) return undefined;
        const names = new Map(
            this.#store
                .queryMembers(share.shareId)
                .map((member) => [member.shareMemberId, member.displayName]),
        );
        const page = this.#store.queryPeerActions(share.shareId, parseCursor(after));
        const entries = page.entries.map((entry) => ({
            action: entry.action,
            capability: entry.capability,
            createdAt: entry.createdAt,
            description: describePeerActivityEntry(entry, names.get(entry.shareMemberId)),
            ...(entry.detail === undefined ? {} : { detail: entry.detail }),
            grantEpoch: entry.grantEpoch,
            outcome: entry.outcome,
            seq: entry.seq,
            shareId: entry.shareId,
            shareMemberId: entry.shareMemberId,
        }));
        const lastSeq = entries.at(-1)?.seq;
        return {
            complete: page.complete,
            entries,
            ...(page.complete || lastSeq === undefined ? {} : { nextCursor: String(lastSeq) }),
        };
    }

    replicaCapabilities(shareId: string): ListSessionShareReplicaCapabilitiesResponse | undefined {
        const replica = this.#store.queryReplica(shareId);
        if (replica === undefined) return undefined;
        // A member's own daemon enforces nothing: every gate runs on the owner's
        // side, where the terminal actually is. What this reports is the set the
        // owner has told this replica it holds, and absence is denial — so a
        // replica that has been told nothing reads as the plain transcript.
        const capabilities = this.#store
            .queryMemberCapabilities(shareId)
            .filter((row) => row.shareMemberId === replica.shareMemberId)
            .map((row) => row.capability);
        return {
            capabilities,
            description: describePeerCapabilities(capabilities),
            shareId,
        };
    }

    health(shareId: string): GetSessionShareHealthResponse | undefined {
        const share = this.#store.queryShare(shareId);
        if (share === undefined) return undefined;
        const pending = this.#store.queryPendingBytes(shareId);
        return {
            health: {
                checkedAt: this.#now(),
                pendingBytes: pending.pendingBytes,
                pendingEntries: pending.pendingEntries,
                state: share.state,
            },
        };
    }

    listReplicas(): ListSessionShareReplicasResponse {
        return { replicas: this.#store.queryReplicas().map(toProtocolReplica) };
    }

    replicaHistory(
        shareId: string,
        after?: string,
    ): GetSessionShareReplicaHistoryResponse | undefined {
        const replica = this.#store.queryReplica(shareId);
        if (replica === undefined) return undefined;
        const afterSequence = parseCursor(after);
        const page = this.#store.queryReplicaHistory(shareId, afterSequence);
        const entries = page.entries.slice(0, MAX_HISTORY_PAGE).map((entry) => ({
            canonicalJson: entry.canonicalJson,
            createdAt: entry.createdAt,
            shareEventId: entry.shareEventId,
            shareSequence: entry.sequence,
        }));
        const complete = page.complete && entries.length === page.entries.length;
        const lastSequence = entries.at(-1)?.shareSequence;
        return {
            complete,
            entries,
            ...(complete || lastSequence === undefined ? {} : { nextCursor: String(lastSequence) }),
            replica: toProtocolReplica(replica),
        };
    }

    async postFriendMessage(
        request: PostSessionShareFriendMessageRequest,
    ): Promise<PostSessionShareFriendMessageResponse> {
        const replica = this.#store.queryReplica(request.grant.shareId);
        if (replica === undefined || replica.state !== "active") {
            throw new Error("This shared session is no longer active.");
        }
        await this.#service.post({
            clientMessageId: request.clientMessageId,
            // The member is posting its own message, so label it honestly rather
            // than with the share title. This name is only advisory: the owner
            // relabels every post with the name it registered for this member.
            displayName: "You",
            grant: request.grant,
            text: request.text,
        });
        return { accepted: true, clientMessageId: request.clientMessageId };
    }

    #requireShareId(sessionId: string): string {
        const share = this.#store.queryActiveShareForSession(sessionId);
        if (share === undefined) throw new Error("This session is not shared.");
        return share.shareId;
    }

    #ownerResponse(shareId: string): SessionShareOwnerResponse {
        const share = this.#store.queryShare(shareId);
        if (share === undefined) throw new Error("This session share no longer exists.");
        const members = this.#store.queryMembers(shareId);
        const byMember = new Map<string, PeerCapability[]>();
        for (const row of this.#store.queryMemberCapabilities(shareId)) {
            const list = byMember.get(row.shareMemberId) ?? [];
            list.push(row.capability);
            byMember.set(row.shareMemberId, list);
        }
        return {
            members: members.map((member) =>
                toProtocolMember(member, byMember.get(member.shareMemberId) ?? []),
            ),
            share: {
                capabilityMemberCount: [...byMember.values()].filter((list) => list.length > 0)
                    .length,
                includeFriendMessagesInModel: share.includeFriendMessagesInModel,
                memberCount: members.filter((member) => member.state === "active").length,
                offerableCapabilities: [...this.#offerableCapabilities(share.ownerSessionId)],
                shareId,
                state: share.state,
                toolOutput: share.toolOutput,
                toolOutputDescription: describeSharedToolOutput(share.toolOutput),
            },
        };
    }
}

function toProtocolMember(
    member: StoredSessionShareMember,
    capabilities: readonly PeerCapability[],
): SessionShareMember {
    // A revoked member holds nothing, whatever rows happen to survive. The
    // durable query already filters to the current epoch, and this is the second
    // place the same answer is reached, on purpose.
    const held = member.state === "active" ? [...capabilities].sort() : [];
    return {
        capabilities: held,
        capabilitiesDescription: describePeerCapabilities(held),
        createdAt: member.createdAt,
        currentGrantEpoch: member.currentGrantEpoch,
        displayName: member.displayName,
        murmurPeerId: member.murmurPeerId,
        shareId: member.shareId,
        shareMemberId: member.shareMemberId,
        state: member.state,
        updatedAt: member.updatedAt,
    };
}

function toProtocolReplica(replica: SessionShareReplicaRecord): SessionShareReplica {
    return {
        createdAt: replica.createdAt,
        ...(replica.endedAt === undefined ? {} : { endedAt: replica.endedAt }),
        ...(replica.endedReason === undefined ? {} : { endedReason: replica.endedReason }),
        grant: {
            grantEpoch: replica.grantEpoch,
            murmurPeerId: replica.murmurPeerId,
            shareId: replica.shareId,
            shareMemberId: replica.shareMemberId,
        },
        memberCount: replica.memberCount,
        ownerPeerId: replica.ownerPeerId,
        state: replica.state,
        title: replica.title,
        updatedAt: replica.updatedAt,
    };
}

function parseCursor(after: string | undefined): number {
    if (after === undefined) return 0;
    const parsed = Number.parseInt(after, 10);
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
        throw new Error("The shared session history cursor is not valid.");
    }
    return parsed;
}
