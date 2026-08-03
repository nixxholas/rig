import type { SessionShareDaemonStore } from "../../session-sharing/SessionShareDaemonService.js";
import type { SessionShareRecord as ServiceShare } from "../../session-sharing/SessionShareService.js";
import type { TX } from "../Transaction.js";
import { querySessionShare, querySessionShareMembers } from "./querySessionShare.js";
import { querySessionShareReplica, querySessionShareReplicas } from "./querySessionShareReplica.js";
import { querySessionShareReplicaEntries } from "./querySessionShareReplica.js";
import { queryRecoverableSessionShares, queryStoppedSessionShares } from "./querySessionShares.js";
import type { SessionShareMemberRecord, SessionShareReplicaRecord } from "./types.js";

const HISTORY_PAGE_LIMIT = 100;

export interface PersistentSessionShareDaemonStoreOptions {
    readonly tx: () => TX;
}

/** Durable reads the daemon's session-sharing API boundary serves directly. */
export class PersistentSessionShareDaemonStore implements SessionShareDaemonStore {
    readonly #tx: () => TX;

    constructor(options: PersistentSessionShareDaemonStoreOptions) {
        this.#tx = options.tx;
    }

    queryShare(shareId: string): ServiceShare | undefined {
        const share = querySessionShare(this.#tx(), shareId);
        return share === undefined ? undefined : this.#toServiceShare(shareId);
    }

    queryActiveShareForSession(ownerSessionId: string): ServiceShare | undefined {
        const share = [
            ...queryRecoverableSessionShares(this.#tx()),
            ...queryStoppedSessionShares(this.#tx()),
        ].find((candidate) => candidate.ownerSessionId === ownerSessionId);
        return share === undefined || share.state === "stopped"
            ? undefined
            : this.#toServiceShare(share.shareId);
    }

    queryPendingBytes(shareId: string): { pendingBytes: number; pendingEntries: number } {
        const share = querySessionShare(this.#tx(), shareId);
        return {
            pendingBytes: share?.outboxBytes ?? 0,
            pendingEntries: share?.outboxCount ?? 0,
        };
    }

    queryReplicas(): readonly SessionShareReplicaRecord[] {
        return querySessionShareReplicas(this.#tx());
    }

    queryReplica(shareId: string): SessionShareReplicaRecord | undefined {
        return querySessionShareReplica(this.#tx(), shareId);
    }

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
    } {
        const entries = querySessionShareReplicaEntries(this.#tx(), shareId, {
            afterSequence,
            limit: HISTORY_PAGE_LIMIT,
        });
        const replica = querySessionShareReplica(this.#tx(), shareId);
        const lastSequence = entries.at(-1)?.sequence ?? afterSequence;
        return {
            complete: lastSequence >= (replica?.appliedThroughSequence ?? 0),
            entries,
        };
    }

    queryMembers(shareId: string): readonly SessionShareMemberRecord[] {
        return querySessionShareMembers(this.#tx(), shareId);
    }

    #toServiceShare(shareId: string): ServiceShare {
        const share = querySessionShare(this.#tx(), shareId);
        if (share === undefined) throw new Error("The session share does not exist.");
        const members = querySessionShareMembers(this.#tx(), shareId);
        return {
            includeFriendMessagesInModel: share.includeFriendMessages,
            members: members.map((member) => ({
                displayName: member.displayName,
                grantEpoch: member.currentGrantEpoch,
                murmurPeerId: member.murmurPeerId,
                shareId: member.shareId,
                shareMemberId: member.shareMemberId,
                state: member.state,
            })),
            ownerPeerId: share.ownerPeerId,
            ownerSessionId: share.ownerSessionId,
            shareId: share.shareId,
            state: share.state,
        };
    }
}
