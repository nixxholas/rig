export type SessionShareState = "active" | "degraded" | "stopped";
export type SessionShareMemberState = "active" | "revoked" | "stopped";
export type SessionShareGrantState = "active" | "revoked" | "stopped";
export type SessionShareMessageDisposition = "pending" | "included" | "overflow";
export type SessionShareReplicaState = "active" | "ended";

export interface SessionShareRecord {
    shareId: string;
    ownerSessionId: string;
    state: SessionShareState;
    includeFriendMessages: boolean;
    ownerPeerId: string;
    snapshotThroughPosition?: number;
    snapshotThroughEventId?: string;
    publishedMessagePosition: number;
    publishedEventSeq: number;
    nextShareSequence: number;
    outboxBytes: number;
    outboxCount: number;
    createdAt: number;
    updatedAt: number;
    stoppedAt?: number;
}

export interface SessionShareMemberRecord {
    shareMemberId: string;
    shareId: string;
    murmurPeerId: string;
    displayName: string;
    currentGrantEpoch: number;
    state: SessionShareMemberState;
    createdAt: number;
    updatedAt: number;
}

export interface SessionShareOutboxRecord {
    shareId: string;
    sequence: number;
    shareEventId: string;
    sourceEventSeq?: number;
    canonicalJson: string;
    contentHash: string;
    byteLength: number;
    createdAt: number;
}

export interface SessionShareReplicaRecord {
    shareId: string;
    ownerPeerId: string;
    murmurPeerId: string;
    shareMemberId: string;
    grantEpoch: number;
    title: string;
    memberCount: number;
    state: SessionShareReplicaState;
    endedReason?: string;
    endedAt?: number;
    createdAt: number;
    updatedAt: number;
}
