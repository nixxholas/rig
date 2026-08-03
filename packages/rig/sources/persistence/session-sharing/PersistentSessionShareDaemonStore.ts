import type { SessionShareDaemonStore } from "../../session-sharing/SessionShareDaemonService.js";
import type { SessionShareRecord as ServiceShare } from "../../session-sharing/SessionShareService.js";
import type { TX } from "../Transaction.js";
import type { SessionShareRecord } from "./types.js";
import { querySessionShare, querySessionShareMembers } from "./querySessionShare.js";
import { querySessionShareForOwnerSession } from "./querySessionShareForOwnerSession.js";
import { querySessionShareReplica, querySessionShareReplicas } from "./querySessionShareReplica.js";
import { querySessionShareReplicaEntries } from "./querySessionShareReplica.js";
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
        return share === undefined ? undefined : this.#toServiceShare(share);
    }

    queryActiveShareForSession(ownerSessionId: string): ServiceShare | undefined {
        const share = querySessionShareForOwnerSession(this.#tx(), ownerSessionId);
        return share === undefined ? undefined : this.#toServiceShare(share);
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

    #toServiceShare(share: SessionShareRecord): ServiceShare {
        const members = querySessionShareMembers(this.#tx(), share.shareId);
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
            toolOutput: share.toolOutput,
        };
    }
}
