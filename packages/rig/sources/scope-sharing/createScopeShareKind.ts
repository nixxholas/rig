import type { SessionEntrySource } from "@slopus/murmur/sharedSession";

import type { PersistentScopeShareCoreStore } from "../persistence/scope-sharing/PersistentScopeShareCoreStore.js";
import type { PersistentScopeShareDaemonStore } from "../persistence/scope-sharing/PersistentScopeShareDaemonStore.js";
import { shareKindOf } from "../sharing/shareId.js";
import {
    shareHistoryPageLimits,
    type ShareKindContext,
    type ShareKindRuntime,
} from "../sharing/createShareRuntime.js";
import { ScopeShareDaemonService } from "./ScopeShareDaemonService.js";
import { ScopeShareService } from "./ScopeShareService.js";
import type { ScopeShareServiceContract } from "./ScopeShareServiceContract.js";

export interface ScopeShareKindOptions {
    readonly daemonStore: PersistentScopeShareDaemonStore;
    readonly shareStore: PersistentScopeShareCoreStore;
}

export interface ScopeShareKindRuntime extends ShareKindRuntime {
    readonly contract: ScopeShareServiceContract;
    /** Publish whatever this session has added to the share covering it, if any. */
    readonly wakeForSession: (scope: { projectId: string; workspaceId?: string }) => void;
}

/**
 * The workspace and project half of sharing, built on the one shared transport.
 *
 * A friend's replica creates no local project, no local workspace, and no folder
 * on disk: it is a read-only view of somebody else's scope, held entirely in the
 * replica tables.
 */
export function createScopeShareKind(
    options: ScopeShareKindOptions,
): (context: ShareKindContext) => ScopeShareKindRuntime {
    return (context) => {
        const service = new ScopeShareService({
            store: options.shareStore,
            transport: context.transport,
        });
        const contract = new ScopeShareDaemonService({
            localPeerId: context.localPeerId,
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
                        scopeKind: existing?.scopeKind ?? scopeKindOfShare(invitation.shareId),
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
                        // has no member session at all, so nothing replicates and nothing can
                        // be retried.
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
            wakeForSession: (scope) => {
                // A session belongs to at most one workspace and always to one project, so
                // both the workspace share and the project share above it may be waiting on
                // it. Waking a scope that is not shared costs one indexed read.
                if (scope.workspaceId !== undefined) {
                    const workspaceShare = options.daemonStore.queryActiveShareForScope({
                        scopeId: scope.workspaceId,
                        scopeKind: "workspace",
                    });
                    if (workspaceShare !== undefined) service.wake(workspaceShare.shareId);
                }
                const projectShare = options.daemonStore.queryActiveShareForScope({
                    scopeId: scope.projectId,
                    scopeKind: "project",
                });
                if (projectShare !== undefined) service.wake(projectShare.shareId);
            },
        };
    };
}

/** The kind a scope share's own identifier already carries, and nothing else does. */
function scopeKindOfShare(shareId: string): "project" | "workspace" {
    return shareKindOf(shareId) === "project" ? "project" : "workspace";
}
