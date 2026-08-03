import { createId } from "@paralleldrive/cuid2";

import type {
    SessionShareCoreStore,
    SessionShareFriendInput,
    SessionShareMemberRecord as CoreMember,
    SessionShareRecord as CoreShare,
    SessionShareReplicaRecord as CoreReplica,
} from "../../session-sharing/SessionShareService.js";
import type {
    SessionShareOpaqueEntry,
    SessionShareTransportGrant,
    SessionShareTransportMemberPost,
} from "../../session-sharing/SessionShareTransport.js";
import { inTx } from "../inTx.js";
import type { TX } from "../Transaction.js";
import { querySessionShare, querySessionShareMembers } from "./querySessionShare.js";
import { querySessionShareForOwnerSession } from "./querySessionShareForOwnerSession.js";
import { querySessionShareEntryLog } from "./querySessionShareEntryLog.js";
import { querySessionShareOutbox } from "./querySessionShareOutbox.js";
import { querySessionShareEndedGrants } from "./querySessionShareEndedGrants.js";
import { querySessionShareReplica, querySessionShareReplicas } from "./querySessionShareReplica.js";
import { queryRecoverableSessionShares, queryStoppedSessionShares } from "./querySessionShares.js";
import { sessionShareAcceptFriendMessage } from "./sessionShareAcceptFriendMessage.js";
import { sessionShareCreate } from "./sessionShareCreate.js";
import { sessionShareGrant } from "./sessionShareGrant.js";
import { sessionShareOutboxAcknowledge } from "./sessionShareOutboxAcknowledge.js";
import { sessionShareReplicaAppend } from "./sessionShareReplicaAppend.js";
import { sessionShareReplicaEndCurrentGrant } from "./sessionShareReplicaEndCurrentGrant.js";
import { sessionShareReplicaSave } from "./sessionShareReplicaSave.js";
import { sessionShareRevoke } from "./sessionShareRevoke.js";
import { sessionShareSetDegraded } from "./sessionShareSetDegraded.js";
import { sessionShareSetIncludeFriendMessages } from "./sessionShareSetIncludeFriendMessages.js";
import { sessionShareStop } from "./sessionShareStop.js";
import { sessionShareTailEvents } from "./sessionShareTailEvents.js";

const MAX_OUTBOX_BYTES = 64 * 1024 * 1024;
const MAX_OUTBOX_COUNT = 100_000;
const TAIL_PAGE_SIZE = 100;

export interface PersistentSessionShareCoreStoreOptions {
    readonly idFactory?: () => string;
    readonly now?: () => number;
    readonly tx: () => TX;
}

export class PersistentSessionShareCoreStore implements SessionShareCoreStore {
    readonly #idFactory: () => string;
    readonly #now: () => number;
    readonly #tx: () => TX;

    constructor(options: PersistentSessionShareCoreStoreOptions) {
        this.#idFactory = options.idFactory ?? createId;
        this.#now = options.now ?? Date.now;
        this.#tx = options.tx;
    }

    createShare(input: {
        friends: readonly SessionShareFriendInput[];
        includeFriendMessagesInModel: boolean;
        ownerPeerId: string;
        ownerSessionId: string;
        shareId: string;
    }): CoreShare {
        const now = this.#now();
        const share = sessionShareCreate(this.#tx(), {
            includeFriendMessages: input.includeFriendMessagesInModel,
            maxOutboxBytes: MAX_OUTBOX_BYTES,
            maxOutboxCount: MAX_OUTBOX_COUNT,
            members: input.friends.map((friend) => ({
                ...friend,
                shareMemberId: this.#idFactory(),
            })),
            now,
            ownerPeerId: input.ownerPeerId,
            ownerSessionId: input.ownerSessionId,
            shareId: input.shareId,
        });
        return this.#shareWithMembers(share.shareId);
    }

    queryShare(shareId: string): CoreShare | undefined {
        return querySessionShare(this.#tx(), shareId) === undefined
            ? undefined
            : this.#shareWithMembers(shareId);
    }

    queryActiveShareForSession(ownerSessionId: string): CoreShare | undefined {
        const share = querySessionShareForOwnerSession(this.#tx(), ownerSessionId);
        return share === undefined ? undefined : this.#shareWithMembers(share.shareId);
    }

    queryRecoverableShares(): readonly CoreShare[] {
        return [
            ...queryRecoverableSessionShares(this.#tx()),
            ...queryStoppedSessionShares(this.#tx()),
        ].map((share) => this.#shareWithMembers(share.shareId));
    }

    queryEndedGrants(shareId: string): readonly SessionShareTransportGrant[] {
        return querySessionShareEndedGrants(this.#tx(), shareId);
    }

    addMember(input: {
        displayName: string;
        murmurPeerId: string;
        shareId: string;
        shareMemberId: string;
    }): CoreMember {
        return toCoreMember(
            sessionShareGrant(this.#tx(), {
                ...input,
                now: this.#now(),
            }),
        );
    }

    revokeMember(shareId: string, shareMemberId: string): CoreMember {
        sessionShareRevoke(this.#tx(), { now: this.#now(), shareId, shareMemberId });
        const member = querySessionShareMembers(this.#tx(), shareId).find(
            (candidate) => candidate.shareMemberId === shareMemberId,
        );
        if (member === undefined) throw new Error("The session share member does not exist.");
        return toCoreMember(member);
    }

    stopShare(shareId: string, options?: { readonly pruneEntryLog: boolean }): CoreShare {
        sessionShareStop(this.#tx(), shareId, this.#now(), options);
        return this.#shareWithMembers(shareId);
    }

    setIncludeFriendMessages(shareId: string, include: boolean): CoreShare {
        sessionShareSetIncludeFriendMessages(this.#tx(), shareId, include, this.#now());
        return this.#shareWithMembers(shareId);
    }

    setShareHealth(shareId: string, state: "active" | "degraded"): void {
        sessionShareSetDegraded(this.#tx(), shareId, state === "degraded", this.#now());
    }

    acceptFriendMessage(
        post: SessionShareTransportMemberPost,
        senderPeerId: string,
        message: Parameters<SessionShareCoreStore["acceptFriendMessage"]>[2],
    ) {
        return sessionShareAcceptFriendMessage(this.#tx(), {
            message,
            now: this.#now(),
            post,
            senderPeerId,
        });
    }

    tailOutbox(shareId: string): number {
        return sessionShareTailEvents(this.#tx(), {
            maxOutboxBytes: MAX_OUTBOX_BYTES,
            maxOutboxCount: MAX_OUTBOX_COUNT,
            now: this.#now(),
            pageSize: TAIL_PAGE_SIZE,
            shareId,
        }).progressed;
    }

    queryOutboxPage(
        shareId: string,
        limits: { maxBytes: number; maxItems: number },
    ): readonly SessionShareOpaqueEntry[] {
        return querySessionShareOutbox(this.#tx(), {
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
    ): { complete: boolean; entries: readonly SessionShareOpaqueEntry[] } {
        return querySessionShareEntryLog(this.#tx(), {
            afterSequence: limits.afterSequence,
            maxBytes: limits.maxBytes,
            maxItems: limits.maxItems,
            shareId,
        });
    }

    acknowledgeOutbox(shareId: string, throughShareSequence: number): void {
        sessionShareOutboxAcknowledge(this.#tx(), {
            now: this.#now(),
            shareId,
            throughSequence: throughShareSequence,
        });
    }

    saveReplica(replica: CoreReplica): void {
        const now = this.#now();
        sessionShareReplicaSave(this.#tx(), {
            createdAt: now,
            grantEpoch: replica.grant.grantEpoch,
            memberCount: replica.memberCount,
            murmurPeerId: replica.grant.murmurPeerId,
            ownerPeerId: replica.ownerPeerId,
            shareId: replica.grant.shareId,
            shareMemberId: replica.grant.shareMemberId,
            state: replica.state,
            title: replica.title,
            updatedAt: now,
        });
    }

    appendReplicaEntries(
        grant: SessionShareTransportGrant,
        entries: readonly SessionShareOpaqueEntry[],
    ): void {
        inTx(this.#tx(), (tx) => {
            for (const entry of entries) {
                sessionShareReplicaAppend(tx, {
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
        grant: SessionShareTransportGrant,
        reason: "revoked" | "stopped",
    ): "ended" | "stale" {
        return sessionShareReplicaEndCurrentGrant(this.#tx(), {
            grantEpoch: grant.grantEpoch,
            now: this.#now(),
            reason,
            shareId: grant.shareId,
            shareMemberId: grant.shareMemberId,
        })
            ? "ended"
            : "stale";
    }

    queryReplicas(): readonly CoreReplica[] {
        return querySessionShareReplicas(this.#tx()).map(toCoreReplica);
    }

    queryReplica(shareId: string): CoreReplica | undefined {
        const replica = querySessionShareReplica(this.#tx(), shareId);
        return replica === undefined ? undefined : toCoreReplica(replica);
    }

    #shareWithMembers(shareId: string): CoreShare {
        const share = querySessionShare(this.#tx(), shareId);
        if (share === undefined) throw new Error("The session share does not exist.");
        return {
            includeFriendMessagesInModel: share.includeFriendMessages,
            members: querySessionShareMembers(this.#tx(), shareId).map(toCoreMember),
            ownerPeerId: share.ownerPeerId,
            ownerSessionId: share.ownerSessionId,
            shareId: share.shareId,
            state: share.state,
        };
    }
}

function toCoreMember(member: ReturnType<typeof querySessionShareMembers>[number]): CoreMember {
    return {
        displayName: member.displayName,
        grantEpoch: member.currentGrantEpoch,
        murmurPeerId: member.murmurPeerId,
        shareId: member.shareId,
        shareMemberId: member.shareMemberId,
        state: member.state,
    };
}

function toCoreReplica(
    replica: NonNullable<ReturnType<typeof querySessionShareReplica>>,
): CoreReplica {
    return {
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
    };
}
