import type {
    AddScopeShareMemberRequest,
    CreateScopeShareRequest,
    GetScopeShareHealthResponse,
    GetScopeShareReplicaResponse,
    GetScopeShareSessionHistoryResponse,
    ListScopeShareReplicasResponse,
    RevokeScopeShareMemberRequest,
    ScopeShareMember,
    ScopeShareOwnerResponse,
    ScopeShareReplica,
    ScopeSharedMetadata,
    StopScopeShareRequest,
} from "../protocol/index.js";
import type {
    ScopeShareMemberRecord as StoredScopeShareMember,
    ScopeShareReplicaRecord,
    ScopeShareScopeKind,
} from "../persistence/scope-sharing/types.js";
import type { ScopeShareSubjectKind } from "./projectScopeShareEntry.js";
import type { ScopeShareRecord, ScopeShareService } from "./ScopeShareService.js";
import type { ScopeShareServiceContract, ScopeShareTarget } from "./ScopeShareServiceContract.js";

const MAX_HISTORY_PAGE = 100;
const INDEX_SUBJECTS: readonly ScopeShareSubjectKind[] = ["scope", "session_index"];
const TRANSCRIPT_SUBJECTS: readonly ScopeShareSubjectKind[] = ["session_event"];

/**
 * Durable state the daemon service reads directly rather than through the
 * transport-facing core store.
 */
export interface ScopeShareDaemonStore {
    queryShare(shareId: string): ScopeShareRecord | undefined;
    queryActiveShareForScope(scope: {
        scopeId: string;
        scopeKind: ScopeShareScopeKind;
    }): ScopeShareRecord | undefined;
    queryPendingBytes(shareId: string): { pendingBytes: number; pendingEntries: number };
    queryReplicas(): readonly ScopeShareReplicaRecord[];
    queryReplica(shareId: string): ScopeShareReplicaRecord | undefined;
    queryReplicaEntries(
        shareId: string,
        options: {
            afterSequence: number;
            sessionId?: string;
            subjectKinds: readonly ScopeShareSubjectKind[];
        },
    ): {
        complete: boolean;
        entries: readonly {
            canonicalJson: string;
            createdAt: number;
            sequence: number;
            shareEventId: string;
        }[];
    };
    queryMembers(shareId: string): readonly StoredScopeShareMember[];
}

export interface ScopeShareDaemonServiceOptions {
    /** Murmur peer ID of the local account, or `undefined` while it has none. */
    readonly localPeerId: () => Promise<string | undefined>;
    readonly now?: () => number;
    readonly service: ScopeShareService;
    readonly store: ScopeShareDaemonStore;
}

/**
 * The daemon's API boundary for sharing a workspace or project.
 *
 * Every owner-side route resolves the share from the scope it names, so a client
 * only ever names the workspace or project it is looking at.
 */
export class ScopeShareDaemonService implements ScopeShareServiceContract {
    readonly #localPeerId: ScopeShareDaemonServiceOptions["localPeerId"];
    readonly #now: () => number;
    readonly #service: ScopeShareService;
    readonly #store: ScopeShareDaemonStore;

    constructor(options: ScopeShareDaemonServiceOptions) {
        this.#localPeerId = options.localPeerId;
        this.#now = options.now ?? Date.now;
        this.#service = options.service;
        this.#store = options.store;
    }

    getOwner(scope: ScopeShareTarget): ScopeShareOwnerResponse | undefined {
        const share = this.#store.queryActiveShareForScope(scope);
        return share === undefined ? undefined : this.#ownerResponse(share.shareId);
    }

    metadata(scope: ScopeShareTarget): ScopeSharedMetadata | undefined {
        const share = this.#store.queryActiveShareForScope(scope);
        return share === undefined ? undefined : this.#ownerResponse(share.shareId).share;
    }

    async create(
        scope: ScopeShareTarget,
        request: CreateScopeShareRequest,
    ): Promise<ScopeShareOwnerResponse> {
        const ownerPeerId = await this.#localPeerId();
        if (ownerPeerId === undefined) {
            throw new Error("Set up a Murmur account before sharing a workspace.");
        }
        const share = await this.#service.create({
            friends: request.friends.map((friend) => ({
                displayName: friend.displayName,
                murmurPeerId: friend.peerId,
            })),
            ownerPeerId,
            scopeId: scope.scopeId,
            scopeKind: scope.scopeKind,
        });
        return this.#ownerResponse(share.shareId);
    }

    async add(
        scope: ScopeShareTarget,
        request: AddScopeShareMemberRequest,
    ): Promise<ScopeShareOwnerResponse> {
        const shareId = this.#requireShareId(scope);
        await this.#service.add({
            displayName: request.friend.displayName,
            murmurPeerId: request.friend.peerId,
            shareId,
        });
        return this.#ownerResponse(shareId);
    }

    async revoke(
        scope: ScopeShareTarget,
        shareMemberId: string,
        _request: RevokeScopeShareMemberRequest,
    ): Promise<ScopeShareOwnerResponse> {
        const shareId = this.#requireShareId(scope);
        await this.#service.revoke(shareId, shareMemberId);
        return this.#ownerResponse(shareId);
    }

    async stop(
        scope: ScopeShareTarget,
        _request: StopScopeShareRequest,
    ): Promise<ScopeShareOwnerResponse> {
        const shareId = this.#requireShareId(scope);
        await this.#service.stop(shareId);
        return this.#ownerResponse(shareId);
    }

    async stopForArchivedWorkspace(workspaceId: string): Promise<void> {
        await this.#service.stopForArchivedWorkspace(workspaceId);
    }

    async stopForArchivedProject(projectId: string): Promise<void> {
        await this.#service.stopForArchivedProject(projectId);
    }

    health(shareId: string): GetScopeShareHealthResponse | undefined {
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

    listReplicas(): ListScopeShareReplicasResponse {
        return { replicas: this.#store.queryReplicas().map(toProtocolReplica) };
    }

    replica(shareId: string, after?: string): GetScopeShareReplicaResponse | undefined {
        const replica = this.#store.queryReplica(shareId);
        if (replica === undefined) return undefined;
        const page = this.#readPage(shareId, {
            ...(after === undefined ? {} : { after }),
            subjectKinds: INDEX_SUBJECTS,
        });
        return { ...page, replica: toProtocolReplica(replica) };
    }

    replicaSessionHistory(
        shareId: string,
        sessionId: string,
        after?: string,
    ): GetScopeShareSessionHistoryResponse | undefined {
        const replica = this.#store.queryReplica(shareId);
        if (replica === undefined) return undefined;
        const page = this.#readPage(shareId, {
            ...(after === undefined ? {} : { after }),
            sessionId,
            subjectKinds: TRANSCRIPT_SUBJECTS,
        });
        return { ...page, replica: toProtocolReplica(replica), sessionId };
    }

    #readPage(
        shareId: string,
        options: {
            after?: string;
            sessionId?: string;
            subjectKinds: readonly ScopeShareSubjectKind[];
        },
    ): {
        complete: boolean;
        entries: {
            canonicalJson: string;
            createdAt: number;
            shareEventId: string;
            shareSequence: number;
        }[];
        nextCursor?: string;
    } {
        const page = this.#store.queryReplicaEntries(shareId, {
            afterSequence: parseCursor(options.after),
            ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
            subjectKinds: options.subjectKinds,
        });
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
        };
    }

    #requireShareId(scope: ScopeShareTarget): string {
        const share = this.#store.queryActiveShareForScope(scope);
        if (share === undefined) throw new Error("This workspace is not shared.");
        return share.shareId;
    }

    #ownerResponse(shareId: string): ScopeShareOwnerResponse {
        const share = this.#store.queryShare(shareId);
        if (share === undefined) throw new Error("This share no longer exists.");
        const members = this.#store.queryMembers(shareId);
        return {
            members: members.map(toProtocolMember),
            share: {
                memberCount: members.filter((member) => member.state === "active").length,
                scopeId: share.scopeId,
                scopeKind: share.scopeKind,
                shareId,
                state: share.state,
            },
        };
    }
}

function toProtocolMember(member: StoredScopeShareMember): ScopeShareMember {
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

function toProtocolReplica(replica: ScopeShareReplicaRecord): ScopeShareReplica {
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
        scopeKind: replica.scopeKind,
        state: replica.state,
        title: replica.title,
        updatedAt: replica.updatedAt,
    };
}

function parseCursor(after: string | undefined): number {
    if (after === undefined) return 0;
    const parsed = Number.parseInt(after, 10);
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
        throw new Error("The shared scope history cursor is not valid.");
    }
    return parsed;
}
