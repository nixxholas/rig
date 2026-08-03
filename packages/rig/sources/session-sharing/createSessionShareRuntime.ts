import type { UserMessage } from "../agent/types.js";
import type { MurmurServiceContract } from "../murmur/types.js";
import type { PersistentSessionShareCoreStore } from "../persistence/session-sharing/PersistentSessionShareCoreStore.js";
import type { PersistentSessionShareDaemonStore } from "../persistence/session-sharing/PersistentSessionShareDaemonStore.js";
import type { SessionEvent } from "../protocol/index.js";
import { MurmurShareDirectory, type ReceivedShareInvitation } from "./MurmurShareDirectory.js";
import { MurmurSessionShareTransport } from "./MurmurSessionShareTransport.js";
import { SessionShareDaemonService } from "./SessionShareDaemonService.js";
import { SessionShareService } from "./SessionShareService.js";
import type { SessionShareServiceContract } from "./SessionShareServiceContract.js";

const HISTORY_PAGE_ENTRIES = 100;
const HISTORY_PAGE_BYTES = 256 * 1024;

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
        try {
            await service.joinReplica({
                grant: {
                    // A member never learns the owner's member IDs, so its grant is local
                    // bookkeeping: a re-invitation after a revocation opens the next epoch.
                    grantEpoch: existing === undefined ? 1 : existing.grantEpoch + 1,
                    murmurPeerId: localPeerId,
                    shareId: invitation.shareId,
                    shareMemberId: invitation.shareId,
                },
                memberCount: existing?.memberCount ?? 0,
                ownerPeerId: invitation.ownerPeerId,
                state: "active",
                title: existing?.title ?? "",
            });
        } catch {
            // A share whose invitation cannot be joined yet stays stored; the next
            // service start replays it from the directory's pending invitations.
        }
    };

    const unregisterRouter = options.murmur.registerEventRouter(async (received) => {
        const outcome = await transport.handleReceivedEvent(received);
        if (outcome !== "unowned") return true;
        return directory.handleReceivedEvent(received);
    });
    // A friend's fresh key package is exactly what a deferred invitation was waiting for.
    const unobserveOffers = directory.onKeyPackageOffered(() => {
        void recoverShares(service);
    });
    const unobserveInvitations = directory.onInvitation((invitation) => {
        void joinReplica(invitation);
    });
    const unobserveRuntime = options.murmur.onRuntimeChanged((runtime) => {
        if (runtime === undefined) return;
        void startForRuntime(service, directory, joinReplica);
    });
    if (options.murmur.runtime() !== undefined) {
        void startForRuntime(service, directory, joinReplica);
    }

    return {
        close: async () => {
            unregisterRouter();
            unobserveOffers();
            unobserveInvitations();
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
 * Bring both halves of sharing back up for a freshly started Murmur service:
 * owner shares recover, friends are re-offered a key package so they can invite
 * this account, and every invitation received while the service was down joins.
 */
async function startForRuntime(
    service: SessionShareService,
    directory: MurmurShareDirectory,
    joinReplica: (invitation: ReceivedShareInvitation) => Promise<void>,
): Promise<void> {
    await recoverShares(service);
    try {
        await directory.publishKeyPackageOffers();
        for (const invitation of await directory.pendingInvitations())
            await joinReplica(invitation);
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
