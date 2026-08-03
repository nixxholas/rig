import type { UserMessage } from "../agent/types.js";
import type { MurmurServiceContract } from "../murmur/types.js";
import type { PersistentSessionShareCoreStore } from "../persistence/session-sharing/PersistentSessionShareCoreStore.js";
import type { PersistentSessionShareDaemonStore } from "../persistence/session-sharing/PersistentSessionShareDaemonStore.js";
import type { SessionShareReplicaRecord } from "../persistence/session-sharing/types.js";
import { rethrowDatabaseFailure } from "../persistence/rethrowDatabaseFailure.js";
import type { SessionEvent } from "../protocol/index.js";
import { MurmurShareDirectory, type ReceivedShareInvitation } from "./MurmurShareDirectory.js";
import { MurmurSessionShareTransport } from "./MurmurSessionShareTransport.js";
import { SessionShareDaemonService } from "./SessionShareDaemonService.js";
import { SessionShareService } from "./SessionShareService.js";
import type { SessionShareServiceContract } from "./SessionShareServiceContract.js";

const HISTORY_PAGE_ENTRIES = 100;
const HISTORY_PAGE_BYTES = 256 * 1024;
const MAX_BACKFILL_ATTEMPTS = 12;
const MAX_BACKFILL_DELAY_MS = 30_000;

function delay(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export interface SessionShareRuntimeOptions {
    /** Applies a friend message to the live session after it is durably stored. */
    readonly deliverFriendMessage: (
        ownerSessionId: string,
        message: UserMessage & {
            contextOnly: true;
            friendAuthor: NonNullable<UserMessage["friendAuthor"]>;
        },
        persisted: {
            createdAt: number;
            event: Extract<SessionEvent, { type: "message_submitted" }>;
            overflowedMessageIds: readonly string[];
            position: number;
        },
    ) => void;
    readonly murmur: MurmurServiceContract;
    /** Surfaces an error the event router absorbed so it is not silently lost. */
    readonly reportFailure?: (error: unknown) => void;
    readonly shareStore: PersistentSessionShareCoreStore;
    readonly daemonStore: PersistentSessionShareDaemonStore;
}

export interface SessionShareRuntime {
    readonly close: () => Promise<void>;
    readonly contract: SessionShareServiceContract;
    /** Publish anything this session has added to a live share. */
    readonly wake: (ownerSessionId: string) => void;
}

/**
 * Assemble session sharing over the real Murmur transport.
 *
 * The runtime follows the Murmur account: shares recover when the service
 * starts, and a stopped service simply leaves the durable outbox to drain on
 * the next start rather than losing anything.
 */
export function createSessionShareRuntime(
    options: SessionShareRuntimeOptions,
): SessionShareRuntime {
    const directory = new MurmurShareDirectory({
        murmur: options.murmur,
        runtime: () => options.murmur.runtime(),
    });
    const transport = new MurmurSessionShareTransport({
        directory,
        entrySource: (shareId) => ({
            readPage: async ({ afterSequence, maximumBytes, maximumEntries }) => {
                const page = options.shareStore.queryEntryPage(shareId, {
                    afterSequence,
                    maxBytes: Math.min(maximumBytes, HISTORY_PAGE_BYTES),
                    maxItems: Math.min(maximumEntries, HISTORY_PAGE_ENTRIES),
                });
                return {
                    done: page.complete,
                    entries: page.entries.map((entry) => ({
                        payload: JSON.parse(entry.canonicalJson) as never,
                        shareEventId: entry.shareEventId,
                        shareSequence: entry.shareSequence,
                        timestamp: entry.createdAt,
                    })),
                };
            },
        }),
        runtime: () => options.murmur.runtime(),
    });
    const service = new SessionShareService({
        deliverFriendMessage: (ownerSessionId, message, persisted) => {
            // Only a message the persistence layer already accepted as a friend post
            // reaches here, so it always carries the context-only friend authorship.
            options.deliverFriendMessage(
                ownerSessionId,
                message as Parameters<SessionShareRuntimeOptions["deliverFriendMessage"]>[1],
                persisted,
            );
        },
        store: options.shareStore,
        transport,
    });
    const contract = new SessionShareDaemonService({
        localPeerId: async () => (await options.murmur.getAccount()).account?.id,
        service,
        store: options.daemonStore,
    });

    const joinReplica = async (invitation: ReceivedShareInvitation): Promise<void> => {
        const localPeerId = (await options.murmur.getAccount()).account?.id;
        if (localPeerId === undefined) return;
        const existing = options.daemonStore.queryReplica(invitation.shareId);
        // A member never learns the owner's member IDs, so its grant is local
        // bookkeeping: a re-invitation after a revocation opens the next epoch.
        const grant = {
            grantEpoch: existing === undefined ? 1 : existing.grantEpoch + 1,
            murmurPeerId: localPeerId,
            shareId: invitation.shareId,
            shareMemberId: invitation.shareId,
        };
        try {
            await service.joinReplica({
                grant,
                memberCount: existing?.memberCount ?? 0,
                ownerPeerId: invitation.ownerPeerId,
                state: "active",
                title: existing?.title ?? "",
            });
        } catch {
            // The invitation's one-use key package is spent either way, so it is retired
            // rather than replayed on every start against a bundle that is already gone.
            await directory.retireInvitation(invitation);
            return;
        }
        await directory.retireInvitation(invitation);
        await backfillReplica(transport, invitation.shareId);
    };

    /** Resume a replica this daemon already joined in an earlier run. */
    const resumeReplica = async (replica: SessionShareReplicaRecord): Promise<void> => {
        const grant = {
            grantEpoch: replica.grantEpoch,
            murmurPeerId: replica.murmurPeerId,
            shareId: replica.shareId,
            shareMemberId: replica.shareMemberId,
        };
        // Murmur holds the durable replica; without reloading it the daemon has no
        // member session at all, so nothing replicates and nothing can be retried.
        if ((await transport.loadMember(grant)) === undefined) return;
        service.observeReplica(grant);
        await backfillReplica(transport, replica.shareId);
    };

    // Draining deferred backfills is coalesced: a member that is waiting on history defers
    // every event that arrives, and one retry pass serves all of them. Murmur re-reads a
    // deferred event every 50ms, so a gap a backfill cannot close would otherwise turn into
    // a permanent 20Hz round of relay traffic. Each unproductive drain therefore waits
    // longer than the last, and a share that never recovers stops asking.
    let draining: Promise<void> | undefined;
    const backoff = new Map<string, number>();
    const drainDeferred = (): void => {
        if (draining !== undefined) return;
        draining = (async () => {
            for (const shareId of transport.takeDeferredShares()) {
                const attempt = backoff.get(shareId) ?? 0;
                if (attempt >= MAX_BACKFILL_ATTEMPTS) continue;
                backoff.set(shareId, attempt + 1);
                if (attempt > 0) await delay(Math.min(2 ** attempt * 100, MAX_BACKFILL_DELAY_MS));
                await backfillReplica(transport, shareId);
            }
        })().finally(() => {
            draining = undefined;
        });
    };
    // A replica that applies an entry has caught up, so its next stall starts over.
    const unobserveProgress = service.onReplicaProgress((shareId) => backoff.delete(shareId));
    const unregisterRouter = options.murmur.registerEventRouter(async (received) => {
        // The router must be total. Murmur's synchronization loop absorbs a thrown
        // non-database error and simply retries the same event, so anything escaping here
        // stalls every topic — friendships included — silently and permanently.
        try {
            const outcome = await transport.handleReceivedEvent(received);
            if (outcome === "retained") drainDeferred();
            if (outcome !== "unowned") return outcome;
            return (await directory.handleReceivedEvent(received)) ? "applied" : "unowned";
        } catch (error: unknown) {
            rethrowDatabaseFailure(error);
            options.reportFailure?.(error);
            // Murmur rolled its own transaction back, so nothing was applied. Letting the
            // caller advance past the event drops it; retaining it stalls every topic
            // behind this one forever, which is strictly worse, and every error that can
            // reach here — an entry for an epoch this replica has moved past, a rejected
            // friend message, a directory envelope that will be re-sent — is either
            // already stale or replayed by its own sender.
            return "unowned";
        }
    });
    // A friend's fresh key package is exactly what a deferred invitation was waiting for.
    const unobserveOffers = directory.onKeyPackageOffered(() => {
        void recoverShares(service);
    });
    const unobserveInvitations = directory.onInvitation((invitation) => {
        void joinReplica(invitation);
    });
    const startAll = (): void => {
        void startForRuntime({
            daemonStore: options.daemonStore,
            directory,
            joinReplica,
            resumeReplica,
            service,
        });
    };
    const unobserveRuntime = options.murmur.onRuntimeChanged((runtime) => {
        // Every cached Murmur session holds the client and store it was built on, so a
        // runtime swap — a restart, or an account deletion that replaces the store — makes
        // all of them dead handles that must be rebuilt rather than written through.
        transport.resetRuntime();
        if (runtime !== undefined) startAll();
    });
    if (options.murmur.runtime() !== undefined) startAll();

    return {
        close: async () => {
            unregisterRouter();
            unobserveOffers();
            unobserveInvitations();
            unobserveProgress();
            unobserveRuntime();
            service.close();
            transport.close();
        },
        contract,
        wake: (ownerSessionId) => {
            const share = options.daemonStore.queryActiveShareForSession(ownerSessionId);
            if (share !== undefined) service.wake(share.shareId);
        },
    };
}

/**
 * Catch one replica up with the history the owner offered it.
 *
 * Murmur backfills history only through `retry`, so a member invited into a
 * share that already had a transcript never sees it unless Rig asks. Left
 * unasked, live entries pile up against Murmur's pending-entry bound and the
 * replica stops replicating altogether.
 */
async function backfillReplica(
    transport: MurmurSessionShareTransport,
    shareId: string,
): Promise<void> {
    try {
        await transport.retry(shareId);
    } catch {
        // Backfill is resumable: the next start, or the next entry that arrives, asks again.
    }
}

/**
 * Bring both halves of sharing back up for a freshly started Murmur service:
 * owner shares recover, friends are re-offered a key package so they can invite
 * this account, every invitation received while the service was down joins, and
 * every active replica resumes the history it had not finished.
 */
async function startForRuntime(context: {
    daemonStore: PersistentSessionShareDaemonStore;
    directory: MurmurShareDirectory;
    joinReplica: (invitation: ReceivedShareInvitation) => Promise<void>;
    resumeReplica: (replica: SessionShareReplicaRecord) => Promise<void>;
    service: SessionShareService;
}): Promise<void> {
    await recoverShares(context.service);
    for (const replica of context.daemonStore.queryReplicas()) {
        if (replica.state !== "active") continue;
        try {
            await context.resumeReplica(replica);
        } catch {
            // A replica that cannot resume yet keeps its durable rows and tries again on
            // the next start rather than failing every other share behind it.
        }
    }
    try {
        await context.directory.publishKeyPackageOffers();
        for (const invitation of await context.directory.pendingInvitations()) {
            await context.joinReplica(invitation);
        }
    } catch {
        // Nothing here is load-bearing for daemon startup: a missed offer is re-requested
        // by the owner that needs it, and a missed invitation replays on the next start.
    }
}

async function recoverShares(service: SessionShareService): Promise<void> {
    try {
        await service.recover();
    } catch {
        // Recovery already recorded degraded health for every share it could not reach; the
        // durable outbox drives the next attempt rather than failing daemon startup.
    }
}
