import type {
    AddSessionShareMemberRequest,
    CreateSessionShareRequest,
    GetSessionShareHealthResponse,
    GetSessionShareReplicaHistoryResponse,
    ListSessionShareReplicasResponse,
    PostSessionShareFriendMessageRequest,
    PostSessionShareFriendMessageResponse,
    RevokeSessionShareMemberRequest,
    SessionShareMember,
    SessionShareOwnerResponse,
    SessionShareReplica,
    SetSessionShareFriendMessagesRequest,
    StopSessionShareRequest,
} from "../protocol/index.js";
import type {
    SessionShareMemberRecord as StoredSessionShareMember,
    SessionShareReplicaRecord,
} from "../persistence/session-sharing/types.js";
import type { SessionShareServiceContract } from "./SessionShareServiceContract.js";
import type { SessionShareRecord, SessionShareService } from "./SessionShareService.js";

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
}

export interface SessionShareDaemonServiceOptions {
    /** Murmur peer ID of the local account, or `undefined` while it has none. */
    readonly localPeerId: () => Promise<string | undefined>;
    readonly now?: () => number;
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
    readonly #service: SessionShareService;
    readonly #store: SessionShareDaemonStore;

    constructor(options: SessionShareDaemonServiceOptions) {
        this.#localPeerId = options.localPeerId;
        this.#now = options.now ?? Date.now;
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
            displayName: replica.title.length === 0 ? "You" : replica.title,
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
        return {
            members: members.map(toProtocolMember),
            share: {
                includeFriendMessagesInModel: share.includeFriendMessagesInModel,
                memberCount: members.filter((member) => member.state === "active").length,
                shareId,
                state: share.state,
            },
        };
    }
}

function toProtocolMember(member: StoredSessionShareMember): SessionShareMember {
    return {
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
