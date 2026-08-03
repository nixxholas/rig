import { createId } from "@paralleldrive/cuid2";

import type {
    ScopeShareCoreStore,
    ScopeShareFriendInput,
    ScopeShareMemberRecord as CoreMember,
    ScopeShareRecord as CoreShare,
    ScopeShareReplicaRecord as CoreReplica,
} from "../../scope-sharing/ScopeShareService.js";
import type { ShareOpaqueEntry, ShareTransportGrant } from "../../sharing/ShareTransport.js";
import { inTx } from "../inTx.js";
import type { TX } from "../Transaction.js";
import {
    queryScopeShare,
    queryScopeShareForScope,
    queryScopeShareMembers,
} from "./queryScopeShare.js";
import { queryScopeShareEndedGrants } from "./queryScopeShareEndedGrants.js";
import { queryScopeShareEntryLog } from "./queryScopeShareEntryLog.js";
import { queryScopeShareOutbox } from "./queryScopeShareOutbox.js";
import {
    queryLiveScopeSharesInProject,
    queryRecoverableScopeShares,
    queryStoppedScopeShares,
} from "./queryScopeShares.js";
import { scopeShareCreate } from "./scopeShareCreate.js";
import { scopeShareGrant } from "./scopeShareGrant.js";
import { scopeShareOutboxAcknowledge } from "./scopeShareOutboxAcknowledge.js";
import { scopeShareReplicaAppend } from "./scopeShareReplicaAppend.js";
import { scopeShareReplicaEndCurrentGrant } from "./scopeShareReplicaEndCurrentGrant.js";
import { scopeShareReplicaSave } from "./scopeShareReplicaSave.js";
import { scopeShareRevoke } from "./scopeShareRevoke.js";
import { scopeShareSetDegraded } from "./scopeShareSetDegraded.js";
import { scopeShareStop } from "./scopeShareStop.js";
import { scopeShareTailSessions, type ScopeShareTailLimits } from "./scopeShareTailSessions.js";
import type { ScopeShareReplicaEndedReason, ScopeShareScopeKind } from "./types.js";

const TAIL_LIMITS: ScopeShareTailLimits = {
    degradeAboveBytes: 64 * 1024 * 1024,
    degradeAboveCount: 100_000,
    passByteLimit: 256 * 1024,
    passEntryLimit: 100,
    sessionPageSize: 25,
};

export interface PersistentScopeShareCoreStoreOptions {
    readonly idFactory?: () => string;
    /**
     * Whether transcript entries travel yet. Scope facts and the session list always
     * do; the transcript is turned on separately so a shared workspace can be brought
     * up without waiting for every session's history to replicate.
     */
    readonly includeTranscript?: boolean;
    readonly now?: () => number;
    readonly tx: () => TX;
}

export class PersistentScopeShareCoreStore implements ScopeShareCoreStore {
    readonly #idFactory: () => string;
    readonly #includeTranscript: boolean;
    readonly #now: () => number;
    readonly #tx: () => TX;

    constructor(options: PersistentScopeShareCoreStoreOptions) {
        this.#idFactory = options.idFactory ?? createId;
        this.#includeTranscript = options.includeTranscript ?? false;
        this.#now = options.now ?? Date.now;
        this.#tx = options.tx;
    }

    createShare(input: {
        friends: readonly ScopeShareFriendInput[];
        ownerPeerId: string;
        scopeId: string;
        scopeKind: ScopeShareScopeKind;
        shareId: string;
    }): CoreShare {
        scopeShareCreate(this.#tx(), {
            members: input.friends.map((friend) => ({
                ...friend,
                shareMemberId: this.#idFactory(),
            })),
            now: this.#now(),
            ownerPeerId: input.ownerPeerId,
            scopeId: input.scopeId,
            scopeKind: input.scopeKind,
            shareId: input.shareId,
        });
        return this.#shareWithMembers(input.shareId);
    }

    queryShare(shareId: string): CoreShare | undefined {
        return queryScopeShare(this.#tx(), shareId) === undefined
            ? undefined
            : this.#shareWithMembers(shareId);
    }

    queryActiveShareForScope(scope: {
        scopeId: string;
        scopeKind: ScopeShareScopeKind;
    }): CoreShare | undefined {
        const share = queryScopeShareForScope(this.#tx(), scope);
        return share === undefined ? undefined : this.#shareWithMembers(share.shareId);
    }

    queryRecoverableShares(): readonly CoreShare[] {
        return [
            ...queryRecoverableScopeShares(this.#tx()),
            ...queryStoppedScopeShares(this.#tx()),
        ].map((share) => this.#shareWithMembers(share.shareId));
    }

    queryLiveSharesInProject(projectId: string): readonly CoreShare[] {
        return queryLiveScopeSharesInProject(this.#tx(), projectId).map((share) =>
            this.#shareWithMembers(share.shareId),
        );
    }

    queryEndedGrants(shareId: string): readonly ShareTransportGrant[] {
        return queryScopeShareEndedGrants(this.#tx(), shareId);
    }

    addMember(input: {
        displayName: string;
        murmurPeerId: string;
        shareId: string;
        shareMemberId: string;
    }): CoreMember {
        return toCoreMember(scopeShareGrant(this.#tx(), { ...input, now: this.#now() }));
    }

    revokeMember(shareId: string, shareMemberId: string): CoreMember {
        scopeShareRevoke(this.#tx(), { now: this.#now(), shareId, shareMemberId });
        const member = queryScopeShareMembers(this.#tx(), shareId).find(
            (candidate) => candidate.shareMemberId === shareMemberId,
        );
        if (member === undefined) throw new Error("The shared scope member does not exist.");
        return toCoreMember(member);
    }

    stopShare(shareId: string): CoreShare {
        scopeShareStop(this.#tx(), shareId, this.#now());
        return this.#shareWithMembers(shareId);
    }

    setShareHealth(shareId: string, state: "active" | "degraded"): void {
        scopeShareSetDegraded(this.#tx(), shareId, state === "degraded", this.#now());
    }

    tailOutbox(shareId: string): number {
        return scopeShareTailSessions(this.#tx(), {
            includeTranscript: this.#includeTranscript,
            limits: TAIL_LIMITS,
            now: this.#now(),
            shareId,
        }).appended;
    }

    queryOutboxPage(
        shareId: string,
        limits: { maxBytes: number; maxItems: number },
    ): readonly ShareOpaqueEntry[] {
        return queryScopeShareOutbox(this.#tx(), {
            limit: limits.maxItems,
            maxBytes: limits.maxBytes,
            shareId,
        }).map((entry) => ({
            canonicalJson: entry.canonicalJson,
            contentHash: entry.contentHash,
            createdAt: entry.createdAt,
            shareEventId: entry.shareEventId,
            shareId: entry.shareId,
            shareSequence: entry.sequence,
        }));
    }

    queryEntryPage(
        shareId: string,
        limits: { afterSequence: number; maxBytes: number; maxItems: number },
    ): { complete: boolean; entries: readonly ShareOpaqueEntry[] } {
        return queryScopeShareEntryLog(this.#tx(), { ...limits, shareId });
    }

    acknowledgeOutbox(shareId: string, throughShareSequence: number): void {
        scopeShareOutboxAcknowledge(this.#tx(), {
            now: this.#now(),
            shareId,
            throughSequence: throughShareSequence,
        });
    }

    saveReplica(replica: CoreReplica): void {
        const now = this.#now();
        scopeShareReplicaSave(this.#tx(), {
            createdAt: now,
            grantEpoch: replica.grant.grantEpoch,
            memberCount: replica.memberCount,
            murmurPeerId: replica.grant.murmurPeerId,
            ownerPeerId: replica.ownerPeerId,
            scopeKind: replica.scopeKind,
            shareId: replica.grant.shareId,
            shareMemberId: replica.grant.shareMemberId,
            state: replica.state,
            title: replica.title,
            updatedAt: now,
        });
    }

    appendReplicaEntries(grant: ShareTransportGrant, entries: readonly ShareOpaqueEntry[]): void {
        inTx(this.#tx(), (tx) => {
            for (const entry of entries) {
                scopeShareReplicaAppend(tx, {
                    canonicalJson: entry.canonicalJson,
                    contentHash: entry.contentHash,
                    createdAt: entry.createdAt,
                    grantEpoch: grant.grantEpoch,
                    grantMemberId: grant.shareMemberId,
                    grantShareId: grant.shareId,
                    sequence: entry.shareSequence,
                    shareEventId: entry.shareEventId,
                    shareId: entry.shareId,
                });
            }
        });
    }

    endReplica(
        grant: ShareTransportGrant,
        reason: ScopeShareReplicaEndedReason,
    ): "ended" | "stale" {
        return scopeShareReplicaEndCurrentGrant(this.#tx(), {
            grantEpoch: grant.grantEpoch,
            now: this.#now(),
            // An owner's removal retires the replica's entries with it. A frame this
            // replica simply cannot apply is a local failure, so what it already received
            // and hash-verified stays readable up to where it stopped.
            pruneEntries: reason !== "unreadable",
            reason,
            shareId: grant.shareId,
            shareMemberId: grant.shareMemberId,
        })
            ? "ended"
            : "stale";
    }

    #shareWithMembers(shareId: string): CoreShare {
        const share = queryScopeShare(this.#tx(), shareId);
        if (share === undefined) throw new Error("The shared workspace or project does not exist.");
        return {
            members: queryScopeShareMembers(this.#tx(), shareId).map(toCoreMember),
            ownerPeerId: share.ownerPeerId,
            scopeId: share.scopeId,
            scopeKind: share.scopeKind,
            shareId: share.shareId,
            state: share.state,
        };
    }
}

function toCoreMember(member: ReturnType<typeof queryScopeShareMembers>[number]): CoreMember {
    return {
        displayName: member.displayName,
        grantEpoch: member.currentGrantEpoch,
        murmurPeerId: member.murmurPeerId,
        shareId: member.shareId,
        shareMemberId: member.shareMemberId,
        state: member.state,
    };
}
