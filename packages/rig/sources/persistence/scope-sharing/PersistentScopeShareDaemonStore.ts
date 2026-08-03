import type { ScopeShareSubjectKind } from "../../scope-sharing/projectScopeShareEntry.js";
import type { ScopeShareDaemonStore } from "../../scope-sharing/ScopeShareDaemonService.js";
import type { ScopeShareRecord as ServiceShare } from "../../scope-sharing/ScopeShareService.js";
import type { TX } from "../Transaction.js";
import {
    queryScopeShare,
    queryScopeShareForScope,
    queryScopeShareMembers,
} from "./queryScopeShare.js";
import {
    queryScopeShareReplica,
    queryScopeShareReplicaEntries,
    queryScopeShareReplicas,
} from "./queryScopeShareReplica.js";
import type {
    ScopeShareMemberRecord,
    ScopeShareRecord,
    ScopeShareReplicaRecord,
    ScopeShareScopeKind,
} from "./types.js";

const HISTORY_PAGE_LIMIT = 100;

export interface PersistentScopeShareDaemonStoreOptions {
    readonly tx: () => TX;
}

/** Durable reads the daemon's scope-sharing API boundary serves directly. */
export class PersistentScopeShareDaemonStore implements ScopeShareDaemonStore {
    readonly #tx: () => TX;

    constructor(options: PersistentScopeShareDaemonStoreOptions) {
        this.#tx = options.tx;
    }

    queryShare(shareId: string): ServiceShare | undefined {
        const share = queryScopeShare(this.#tx(), shareId);
        return share === undefined ? undefined : this.#toServiceShare(share);
    }

    queryActiveShareForScope(scope: {
        scopeId: string;
        scopeKind: ScopeShareScopeKind;
    }): ServiceShare | undefined {
        const share = queryScopeShareForScope(this.#tx(), scope);
        return share === undefined ? undefined : this.#toServiceShare(share);
    }

    queryPendingBytes(shareId: string): { pendingBytes: number; pendingEntries: number } {
        const share = queryScopeShare(this.#tx(), shareId);
        return {
            pendingBytes: share?.outboxBytes ?? 0,
            pendingEntries: share?.outboxCount ?? 0,
        };
    }

    queryReplicas(): readonly ScopeShareReplicaRecord[] {
        return queryScopeShareReplicas(this.#tx());
    }

    queryReplica(shareId: string): ScopeShareReplicaRecord | undefined {
        return queryScopeShareReplica(this.#tx(), shareId);
    }

    /**
     * A page of one replica's log, narrowed to a subject.
     *
     * The scope's facts and its session list are what a client needs to draw the
     * shared workspace at all; one session's transcript is a separate, much longer
     * read, so the two are paged apart rather than interleaved.
     */
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
    } {
        const replica = queryScopeShareReplica(this.#tx(), shareId);
        if (replica === undefined) return { complete: true, entries: [] };
        const wanted = new Set(options.subjectKinds);
        const entries: {
            canonicalJson: string;
            createdAt: number;
            sequence: number;
            shareEventId: string;
        }[] = [];
        let afterSequence = options.afterSequence;
        // The wanted subjects are scattered through one log, so a page of the log is
        // read repeatedly until this subject's page is full or the log is exhausted.
        while (entries.length < HISTORY_PAGE_LIMIT) {
            const page = queryScopeShareReplicaEntries(this.#tx(), shareId, {
                afterSequence,
                limit: HISTORY_PAGE_LIMIT,
                ...(options.sessionId === undefined ? {} : { subjectId: options.sessionId }),
            });
            if (page.length === 0) return { complete: true, entries };
            afterSequence = page.at(-1)!.sequence;
            for (const entry of page) {
                if (!wanted.has(entry.subjectKind)) continue;
                entries.push({
                    canonicalJson: entry.canonicalJson,
                    createdAt: entry.createdAt,
                    sequence: entry.sequence,
                    shareEventId: entry.shareEventId,
                });
                if (entries.length === HISTORY_PAGE_LIMIT) break;
            }
        }
        return { complete: afterSequence >= replica.appliedThroughSequence, entries };
    }

    queryMembers(shareId: string): readonly ScopeShareMemberRecord[] {
        return queryScopeShareMembers(this.#tx(), shareId);
    }

    #toServiceShare(share: ScopeShareRecord): ServiceShare {
        return {
            members: queryScopeShareMembers(this.#tx(), share.shareId).map((member) => ({
                displayName: member.displayName,
                grantEpoch: member.currentGrantEpoch,
                murmurPeerId: member.murmurPeerId,
                shareId: member.shareId,
                shareMemberId: member.shareMemberId,
                state: member.state,
            })),
            ownerPeerId: share.ownerPeerId,
            scopeId: share.scopeId,
            scopeKind: share.scopeKind,
            shareId: share.shareId,
            state: share.state,
        };
    }
}
