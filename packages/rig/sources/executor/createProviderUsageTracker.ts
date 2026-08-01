import type { ProviderUsage } from "@slopus/rig-providers";

import { asyncQueue, forever, type GracefulShutdown } from "../concurrency/index.js";

/** How often each provider is asked for its usage. */
export const PROVIDER_USAGE_POLL_INTERVAL_MS = 15 * 60 * 1_000;

export interface ProviderUsageEntry {
    providerId: string;
    /** The last reading, or null when the provider has never answered. */
    usage: ProviderUsage | null;
    /** When we last finished asking, whatever the answer was. */
    checkedAt: number | null;
    /** Why the last attempt produced nothing, when it produced nothing. */
    error: string | null;
}

export interface ProviderUsageTracker {
    /** Every tracked provider, including those that have never answered. */
    all(): readonly ProviderUsageEntry[];
    get(providerId: string): ProviderUsageEntry | undefined;
    /** Asks one provider now, outside the schedule, and stores the result. */
    refresh(providerId: string): Promise<ProviderUsageEntry | undefined>;
    /** Starts one polling loop per provider. */
    start(): void;
}

export interface CreateProviderUsageTrackerOptions {
    /** Asks one provider for its usage. Resolves null when it cannot answer. */
    loadUsage: (providerId: string) => Promise<ProviderUsage | null>;
    now?: () => number;
    intervalMs?: number;
    onError?: (providerId: string, error: unknown) => void;
    providerIds: readonly string[];
    shutdown: GracefulShutdown;
}

/**
 * Keeps each provider's latest usage in memory.
 *
 * One named `forever` per provider, so the providers poll in parallel and a
 * slow or broken vendor cannot hold up the others. Nothing is persisted and
 * nothing is pushed: a client that wants to draw this asks for it.
 */
export function createProviderUsageTracker(
    options: CreateProviderUsageTrackerOptions,
): ProviderUsageTracker {
    const now = options.now ?? Date.now;
    const intervalMs = options.intervalMs ?? PROVIDER_USAGE_POLL_INTERVAL_MS;
    const entries = new Map<string, ProviderUsageEntry>(
        options.providerIds.map((providerId) => [
            providerId,
            { providerId, usage: null, checkedAt: null, error: null },
        ]),
    );
    const pollingQueues = new Map(
        [...entries.keys()].map((providerId) => [providerId, asyncQueue()]),
    );
    let started = false;

    async function poll(providerId: string): Promise<ProviderUsageEntry | undefined> {
        const entry = entries.get(providerId);
        const queue = pollingQueues.get(providerId);
        if (entry === undefined || queue === undefined) return undefined;
        return queue.runInLock(async () => {
            try {
                const usage = await options.loadUsage(providerId);
                entry.checkedAt = now();
                // A provider that cannot answer keeps its previous reading, which
                // stays honest because every reading carries its own capture time.
                if (usage !== null) {
                    entry.usage = usage;
                    entry.error = null;
                } else {
                    entry.error = "The provider did not report usage.";
                }
            } catch (error) {
                entry.checkedAt = now();
                entry.error = error instanceof Error ? error.message : String(error);
                options.onError?.(providerId, error);
            }
            return entry;
        });
    }

    return {
        all() {
            return [...entries.values()];
        },
        get(providerId) {
            return entries.get(providerId);
        },
        refresh(providerId) {
            return poll(providerId);
        },
        start() {
            if (started) return;
            started = true;
            for (const providerId of entries.keys()) {
                const name = `provider-usage:${providerId}`;
                // A poll never throws, so the loop's own backoff stays idle and
                // the schedule is exactly the interval.
                const loop = forever(
                    { name, delay: intervalMs, signal: options.shutdown.signal },
                    async () => {
                        await poll(providerId);
                    },
                );
                options.shutdown.register(name, () => loop);
            }
        },
    };
}
