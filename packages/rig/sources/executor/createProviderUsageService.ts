import { ProviderUsageRequestError, type ProviderUsage } from "@slopus/rig-providers";

import { PROVIDER_USAGE_POLL_INTERVAL_MS } from "./createProviderUsageTracker.js";

interface ProviderUsageCacheEntry {
    hasValue: boolean;
    lastError: unknown;
    nextLoadAt: number;
    pending: Promise<ProviderUsage | null> | undefined;
    retryAt: number;
    value: ProviderUsage | null;
}

export interface ProviderUsageService {
    get(providerId: string, options?: { fresh?: boolean }): Promise<ProviderUsage | null>;
}

export interface CreateProviderUsageServiceOptions {
    loadUsage: (providerId: string) => Promise<ProviderUsage | null>;
    minimumRefreshIntervalMs?: number;
    now?: () => number;
    onError?: (providerId: string, error: unknown) => void;
}

/**
 * Owns the one upstream usage reading for each configured provider.
 *
 * The daemon's scheduled poll and session quota reads both pass through this
 * cache, so concurrent reads cannot issue duplicate requests. Session quota
 * observations may bypass the ordinary refresh interval, but never a provider
 * retry boundary. A failed refresh keeps serving the last successful reading.
 */
export function createProviderUsageService(
    options: CreateProviderUsageServiceOptions,
): ProviderUsageService {
    const now = options.now ?? Date.now;
    const minimumRefreshIntervalMs =
        options.minimumRefreshIntervalMs ?? PROVIDER_USAGE_POLL_INTERVAL_MS;
    const entries = new Map<string, ProviderUsageCacheEntry>();

    function entryFor(providerId: string): ProviderUsageCacheEntry {
        let entry = entries.get(providerId);
        if (entry === undefined) {
            entry = {
                hasValue: false,
                lastError: undefined,
                nextLoadAt: 0,
                pending: undefined,
                retryAt: 0,
                value: null,
            };
            entries.set(providerId, entry);
        }
        return entry;
    }

    return {
        get(providerId, getOptions) {
            const entry = entryFor(providerId);
            if (entry.pending !== undefined) return entry.pending;
            const currentTime = now();
            if (
                currentTime < entry.retryAt ||
                (getOptions?.fresh !== true && currentTime < entry.nextLoadAt)
            ) {
                if (entry.hasValue) return Promise.resolve(entry.value);
                return Promise.reject(entry.lastError);
            }

            const request = options
                .loadUsage(providerId)
                .then((usage) => {
                    entry.hasValue = true;
                    entry.lastError = undefined;
                    entry.nextLoadAt = now() + minimumRefreshIntervalMs;
                    entry.retryAt = 0;
                    entry.value = usage;
                    return usage;
                })
                .catch((error: unknown) => {
                    entry.lastError = error;
                    const providerRetryAt =
                        error instanceof ProviderUsageRequestError ? error.retryAt : undefined;
                    entry.retryAt = Math.max(
                        now() + minimumRefreshIntervalMs,
                        providerRetryAt ?? 0,
                    );
                    entry.nextLoadAt = entry.retryAt;
                    options.onError?.(providerId, error);
                    if (entry.hasValue) return entry.value;
                    throw error;
                })
                .finally(() => {
                    if (entry.pending === request) entry.pending = undefined;
                });
            entry.pending = request;
            return request;
        },
    };
}
