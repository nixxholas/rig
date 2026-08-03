import type { ScopeShareSubjectKind } from "../../scope-sharing/projectScopeShareEntry.js";

/** Whether a share covers one workspace or a whole project. */
export type ScopeShareScopeKind = "workspace" | "project";
export type ScopeShareState = "active" | "degraded" | "stopped";
export type ScopeShareMemberState = "active" | "revoked" | "stopped";
export type ScopeShareGrantState = "active" | "revoked" | "stopped";
export type ScopeShareReplicaState = "active" | "ended";
/** Why a replica stopped: the owner retired it, or this daemon could not read it. */
export type ScopeShareReplicaEndedReason = "revoked" | "stopped" | "unreadable";

export interface ScopeShareRecord {
    shareId: string;
    scopeKind: ScopeShareScopeKind;
    scopeId: string;
    projectId: string;
    state: ScopeShareState;
    ownerPeerId: string;
    nextShareSequence: number;
    /**
     * The scope row version last published as a `scope` entry, so a rename or a
     * branch change is noticed without re-publishing identical facts every pass.
     */
    publishedScopeVersion: number;
    outboxBytes: number;
    outboxCount: number;
    createdAt: number;
    updatedAt: number;
    stoppedAt?: number;
}

export interface ScopeShareMemberRecord {
    shareMemberId: string;
    shareId: string;
    murmurPeerId: string;
    displayName: string;
    currentGrantEpoch: number;
    state: ScopeShareMemberState;
    createdAt: number;
    updatedAt: number;
}

export interface ScopeShareOutboxRecord {
    shareId: string;
    sequence: number;
    shareEventId: string;
    subjectKind: ScopeShareSubjectKind;
    subjectId: string;
    sourceEventSeq?: number;
    canonicalJson: string;
    contentHash: string;
    byteLength: number;
    createdAt: number;
}

/** One session's place in a scope share's round-robin tail. */
export interface ScopeShareSessionCursorRecord {
    shareId: string;
    sessionId: string;
    /** Position in the queue: the lowest takes the next turn. */
    rotationSeq: number;
    publishedEventSeq: number;
    /**
     * The session row stamp the last `session_index` entry described, so facts that
     * have not changed are never published a second time.
     */
    indexVersion: number;
    createdAt: number;
    updatedAt: number;
}

export interface ScopeShareReplicaRecord {
    shareId: string;
    scopeKind: ScopeShareScopeKind;
    ownerPeerId: string;
    murmurPeerId: string;
    shareMemberId: string;
    grantEpoch: number;
    appliedThroughSequence: number;
    title: string;
    memberCount: number;
    state: ScopeShareReplicaState;
    endedReason?: ScopeShareReplicaEndedReason;
    endedAt?: number;
    createdAt: number;
    updatedAt: number;
}
