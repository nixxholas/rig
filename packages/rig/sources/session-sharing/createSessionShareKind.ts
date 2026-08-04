import type { SessionEntrySource } from "@slopus/murmur/sharedSession";

import type { UserMessage } from "../agent/types.js";
import type { PersistentSessionShareCoreStore } from "../persistence/session-sharing/PersistentSessionShareCoreStore.js";
import type { PersistentSessionShareDaemonStore } from "../persistence/session-sharing/PersistentSessionShareDaemonStore.js";
import type { DockerExecutionConfig } from "../execution/index.js";
import type { SessionEvent } from "../protocol/index.js";
import {
    shareHistoryPageLimits,
    type ShareKindContext,
    type ShareKindRuntime,
} from "../sharing/createShareRuntime.js";
import {
    handlePeerTerminalControl,
    resolveOfferablePeerCapabilities,
    type PeerTerminalViewerService,
} from "./peer-access/index.js";
import { SessionShareDaemonService } from "./SessionShareDaemonService.js";
import {
    SessionShareService,
    type SessionShareCapabilityChange,
    type SessionSharePeerAccess,
} from "./SessionShareService.js";
import type { SessionShareServiceContract } from "./SessionShareServiceContract.js";

export interface SessionShareKindOptions {
    readonly daemonStore: PersistentSessionShareDaemonStore;
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
    /**
     * The project's container environment for a shared session, when it has one.
     *
     * `undefined` means the session runs on the host, and every peer capability
     * that would expose the host is refused with a readable reason rather than
     * quietly hidden.
     */
    readonly docker?: (ownerSessionId: string) => DockerExecutionConfig | undefined;
    /** Live peer channels, so a revoke closes them before it touches the network. */
    readonly peerAccess?: SessionSharePeerAccess;
    /**
     * Mirrors container terminals to peers who hold `terminal_view`.
     *
     * Absent means this daemon accepts no peer terminal requests at all: a
     * control frame asking for one is dropped rather than interpreted.
     */
    readonly peerTerminalViewer?: PeerTerminalViewerService;
    /** Told when a member's capability set changes, for the light stream event. */
    readonly publishCapabilities?: (change: SessionShareCapabilityChange) => void;
    readonly shareStore: PersistentSessionShareCoreStore;
}

export interface SessionShareKindRuntime extends ShareKindRuntime {
    readonly contract: SessionShareServiceContract;
    /** Publish anything this session has added to a live share. */
    readonly wake: (ownerSessionId: string) => void;
}

/**
 * The session half of sharing, built on the one shared transport.
 *
 * A session share replicates exactly one session's transcript and is the only
 * kind that carries friend messages back to the owner, so it stays its own
 * service rather than being folded into the wider scope machinery.
 */
export function createSessionShareKind(
    options: SessionShareKindOptions,
): (context: ShareKindContext) => SessionShareKindRuntime {
    return (context) => {
        const service = new SessionShareService({
            deliverFriendMessage: (ownerSessionId, message, persisted) => {
                // Only a message the persistence layer already accepted as a friend post
                // reaches here, so it always carries the context-only friend authorship.
                options.deliverFriendMessage(
                    ownerSessionId,
                    message as Parameters<SessionShareKindOptions["deliverFriendMessage"]>[1],
                    persisted,
                );
            },
            ...(options.peerTerminalViewer === undefined
                ? {}
                : {
                      handleMemberControl: (control) => {
                          // The channel comes from the transport, which knows only sessions
                          // this daemon actually holds; the grant comes from the frame
                          // Murmur authenticated. Neither is taken from the payload.
                          handlePeerTerminalControl(control, {
                              channel: (shareId) =>
                                  context.transport.openOwnerEphemeralChannel(shareId),
                              viewer: options.peerTerminalViewer!,
                          });
                      },
                  }),
            ...(options.peerAccess === undefined ? {} : { peerAccess: options.peerAccess }),
            ...(options.publishCapabilities === undefined
                ? {}
                : { publishCapabilities: options.publishCapabilities }),
            store: options.shareStore,
            transport: context.transport,
        });
        const contract = new SessionShareDaemonService({
            localPeerId: context.localPeerId,
            offerableCapabilities: (ownerSessionId) =>
                resolveOfferablePeerCapabilities(options.docker?.(ownerSessionId)),
            service,
            store: options.daemonStore,
        });
        return {
            close: () => {
                service.close();
            },
            contract,
            entrySource: (shareId): SessionEntrySource => ({
                readPage: async (request) => {
                    const page = options.shareStore.queryEntryPage(shareId, {
                        afterSequence: request.afterSequence,
                        ...shareHistoryPageLimits(request),
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
            flushReplicaEnds: () => {
                service.flushReplicaEnds();
            },
            joinReplica: async (invitation) => {
                const localPeerId = await context.localPeerId();
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
                    // The invitation's one-use key package is spent either way, so it is
                    // retired rather than replayed on every start against a bundle that is
                    // already gone.
                    await context.directory.retireInvitation(invitation);
                    return;
                }
                await context.directory.retireInvitation(invitation);
                await context.backfill(invitation.shareId);
            },
            recoverShares: async () => {
                try {
                    await service.recover();
                } catch {
                    // Recovery already recorded degraded health for every share it could not
                    // reach; the durable outbox drives the next attempt rather than failing
                    // daemon startup.
                }
            },
            resumeReplicas: async () => {
                for (const replica of options.daemonStore.queryReplicas()) {
                    if (replica.state !== "active") continue;
                    const grant = {
                        grantEpoch: replica.grantEpoch,
                        murmurPeerId: replica.murmurPeerId,
                        shareId: replica.shareId,
                        shareMemberId: replica.shareMemberId,
                    };
                    try {
                        // Murmur holds the durable replica; without reloading it the daemon
                        // has no member session at all, so nothing replicates and nothing
                        // can be retried.
                        if ((await context.transport.loadMember(grant)) === undefined) continue;
                        service.observeReplica(grant);
                        await context.backfill(replica.shareId);
                    } catch {
                        // A replica that cannot resume yet keeps its durable rows and tries
                        // again on the next start rather than failing every other share
                        // behind it.
                    }
                }
            },
            shareKinds: ["session"],
            wake: (ownerSessionId) => {
                const share = options.daemonStore.queryActiveShareForSession(ownerSessionId);
                if (share !== undefined) service.wake(share.shareId);
            },
        };
    };
}
