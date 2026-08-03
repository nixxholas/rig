import type { SessionEntrySource } from "@slopus/murmur/sharedSession";

import { delay } from "../concurrency/index.js";
import type { MurmurServiceContract } from "../murmur/types.js";
import { rethrowDatabaseFailure } from "../persistence/rethrowDatabaseFailure.js";
import { MurmurShareDirectory, type ReceivedShareInvitation } from "./MurmurShareDirectory.js";
import { MurmurShareTransport } from "./MurmurShareTransport.js";
import { shareKindOf, type ShareKind } from "./shareId.js";

const HISTORY_PAGE_ENTRIES = 100;
const HISTORY_PAGE_BYTES = 256 * 1024;
const BACKFILL_DELAY_STEP_MS = 100;
const MAX_BACKFILL_DELAY_MS = 30_000;

/**
 * Everything one kind of share needs from the single shared transport.
 *
 * The directory, the transport, and the Murmur event router are singletons by
 * construction: a second directory would race the first over one-use key-package
 * offers, and a second router would race it over relay cursors. So every kind is
 * built on top of this one context rather than assembling its own.
 */
export interface ShareKindContext {
    /** Catch one replica up with the history its owner offered it. */
    readonly backfill: (shareId: string) => Promise<boolean>;
    readonly directory: MurmurShareDirectory;
    /** Murmur peer ID of the local account, or `undefined` while it has none. */
    readonly localPeerId: () => Promise<string | undefined>;
    readonly transport: MurmurShareTransport;
}

/** What the shared runtime asks of one kind of share. */
export interface ShareKindRuntime {
    readonly close: () => void;
    /** Authoritative history this kind offers to a newly invited member. */
    readonly entrySource: (shareId: string) => SessionEntrySource;
    /** Retire the replicas that failed to apply an entry in the committed transaction. */
    readonly flushReplicaEnds: () => void;
    /** Join the replica an owner just invited this account into. */
    readonly joinReplica: (invitation: ReceivedShareInvitation) => Promise<void>;
    /** Re-establish every owner share of this kind after the Murmur runtime came up. */
    readonly recoverShares: () => Promise<void>;
    /** Resume every replica of this kind that an earlier run had already joined. */
    readonly resumeReplicas: () => Promise<void>;
}

export type ShareKindFactory<Runtime extends ShareKindRuntime = ShareKindRuntime> = (
    context: ShareKindContext,
) => Runtime;

export interface ShareRuntimeOptions<Kinds extends Partial<Record<ShareKind, ShareKindFactory>>> {
    /** One factory per kind of share this daemon replicates. */
    readonly kinds: Kinds;
    readonly murmur: MurmurServiceContract;
    /** Surfaces an error the event router absorbed so it is not silently lost. */
    readonly reportFailure?: (error: unknown) => void;
}

/** The runtimes a set of factories produces, keyed by the kind each one serves. */
export type ShareKindRuntimes<Kinds extends Partial<Record<ShareKind, ShareKindFactory>>> = {
    [Kind in keyof Kinds]: Kinds[Kind] extends ShareKindFactory<infer Runtime> ? Runtime : never;
};

export interface ShareRuntime<Kinds extends Partial<Record<ShareKind, ShareKindFactory>>> {
    readonly close: () => Promise<void>;
    /** The runtimes the factories produced, so a caller can reach each kind's own surface. */
    readonly kinds: ShareKindRuntimes<Kinds>;
}

/**
 * Assemble sharing over the real Murmur transport.
 *
 * The runtime follows the Murmur account: shares recover when the service
 * starts, and a stopped service simply leaves the durable outbox to drain on
 * the next start rather than losing anything. Every kind of share — a session, a
 * workspace, a project — rides the same transport, directory, and router, and is
 * told apart by the kind its shareId carries.
 */
export function createShareRuntime<Kinds extends Partial<Record<ShareKind, ShareKindFactory>>>(
    options: ShareRuntimeOptions<Kinds>,
): ShareRuntime<Kinds> {
    const directory = new MurmurShareDirectory({
        murmur: options.murmur,
        runtime: () => options.murmur.runtime(),
    });
    const transport = new MurmurShareTransport({
        directory,
        entrySource: (shareId) => requireKind(shareId).entrySource(shareId),
        runtime: () => options.murmur.runtime(),
    });

    const built = new Map<ShareKind, ShareKindRuntime>();
    const kindOf = (shareId: string): ShareKindRuntime | undefined =>
        built.get(shareKindOf(shareId));
    const requireKind = (shareId: string): ShareKindRuntime => {
        const kind = kindOf(shareId);
        if (kind === undefined) {
            throw new Error("This share's kind is not one this Rig knows how to replicate.");
        }
        return kind;
    };
    /**
     * Murmur applies history entries through `retry` as well as through the event
     * loop, so this is the other moment its transaction becomes durable. Without
     * flushing here, a replica that could not read a backfilled entry would keep
     * reporting active until some unrelated event happened to reach the router.
     */
    const backfill = async (shareId: string): Promise<boolean> => {
        try {
            return await transport.retry(shareId);
        } catch {
            // Backfill is resumable: the next start, or the next entry that arrives, asks again.
            return false;
        } finally {
            flushAll();
        }
    };
    const flushAll = (): void => {
        for (const kind of built.values()) kind.flushReplicaEnds();
    };
    const context: ShareKindContext = {
        backfill,
        directory,
        localPeerId: async () => (await options.murmur.getAccount()).account?.id,
        transport,
    };
    const kinds = {} as ShareKindRuntimes<Kinds>;
    for (const [kind, factory] of Object.entries(options.kinds) as [
        ShareKind,
        ShareKindFactory | undefined,
    ][]) {
        if (factory === undefined) continue;
        const runtime = factory(context);
        built.set(kind, runtime);
        kinds[kind as keyof Kinds] = runtime as ShareKindRuntimes<Kinds>[keyof Kinds];
    }

    // A member that is waiting on history defers every event that arrives, and Murmur
    // re-reads a deferred event every 50ms. Backfilling on each of those would be a
    // permanent 20Hz round of relay traffic, so each share spaces its unproductive attempts
    // further apart, up to a ceiling it then holds. It never stops asking: the gap usually
    // closes when the owner comes back, and a replica that gave up would sit silently
    // broken until the daemon restarted.
    //
    // `concurrency/backoff` is deliberately not used. It retries until the work succeeds,
    // whereas each attempt here is driven by a fresh deferral — so a replica that ends
    // while stalled simply stops being signalled, instead of spinning at the ceiling for
    // the life of the daemon against a share that no longer exists.
    //
    // Closing the runtime aborts every pending wait, so a 30-second timer cannot hold the
    // process open or fire a retry into a transport that is already shut down.
    const backfillAbort = new AbortController();
    const backfillSignal = backfillAbort.signal;
    const backfills = new Map<string, { attempt: number; pending: boolean }>();
    const scheduleBackfill = (shareId: string): void => {
        // A router callback already in flight when the runtime closed would otherwise reach
        // a destroyed transport, whose loader would rebuild the very session close() tore
        // down and leak it.
        if (backfillSignal.aborted) return;
        const state = backfills.get(shareId) ?? { attempt: 0, pending: false };
        backfills.set(shareId, state);
        if (state.pending) return;
        state.pending = true;
        void (async () => {
            try {
                if (state.attempt > 0) {
                    await delay(
                        Math.min(
                            2 ** state.attempt * BACKFILL_DELAY_STEP_MS,
                            MAX_BACKFILL_DELAY_MS,
                        ),
                        backfillSignal,
                    );
                }
                state.attempt += 1;
                // A pass that moves history is progress, so the next stall starts over.
                if (await backfill(shareId)) state.attempt = 0;
            } catch {
                // The runtime is closing; the next start resumes this replica from its rows.
            } finally {
                state.pending = false;
            }
        })();
    };
    const drainDeferred = (): void => {
        for (const shareId of transport.takeDeferredShares()) scheduleBackfill(shareId);
    };
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
        } finally {
            // Murmur's transaction is durable once the transport returns, so anything the
            // handlers had to hold until then is applied here — including on the failure
            // path, where the entry that could not be applied is exactly what queued it.
            flushAll();
        }
    });
    const joinReplica = async (invitation: ReceivedShareInvitation): Promise<void> => {
        // An invitation into a kind this Rig cannot replicate is left where it is: a
        // build that does know the kind picks it up, and retiring it would spend the
        // one-use key package on nothing.
        await kindOf(invitation.shareId)?.joinReplica(invitation);
    };
    const recoverAll = async (): Promise<void> => {
        for (const kind of built.values()) await kind.recoverShares();
    };
    // A friend's fresh key package is exactly what a deferred invitation was waiting for.
    const unobserveOffers = directory.onKeyPackageOffered(() => {
        void recoverAll();
    });
    const unobserveInvitations = directory.onInvitation((invitation) => {
        void joinReplica(invitation);
    });
    const startAll = (): void => {
        void startForRuntime({ directory, joinReplica, kinds: built, recoverAll });
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
            backfillAbort.abort();
            unregisterRouter();
            unobserveOffers();
            unobserveInvitations();
            unobserveRuntime();
            for (const kind of built.values()) kind.close();
            transport.close();
        },
        kinds,
    };
}

/**
 * The page bounds every kind's history offer honours.
 *
 * Murmur asks for as much as it can carry; a share answers with a page that stays
 * inside Rig's own bounds so one catch-up never reads an unbounded amount.
 */
export function shareHistoryPageLimits(request: { maximumBytes: number; maximumEntries: number }): {
    maxBytes: number;
    maxItems: number;
} {
    return {
        maxBytes: Math.min(request.maximumBytes, HISTORY_PAGE_BYTES),
        maxItems: Math.min(request.maximumEntries, HISTORY_PAGE_ENTRIES),
    };
}

/**
 * Bring both halves of sharing back up for a freshly started Murmur service:
 * owner shares recover, friends are re-offered a key package so they can invite
 * this account, every invitation received while the service was down joins, and
 * every active replica resumes the history it had not finished.
 */
async function startForRuntime(context: {
    directory: MurmurShareDirectory;
    joinReplica: (invitation: ReceivedShareInvitation) => Promise<void>;
    kinds: ReadonlyMap<ShareKind, ShareKindRuntime>;
    recoverAll: () => Promise<void>;
}): Promise<void> {
    await context.recoverAll();
    for (const kind of context.kinds.values()) {
        try {
            await kind.resumeReplicas();
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
