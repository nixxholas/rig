import {
    createProviderQuotaCache,
    fetchCodexProviderQuota,
    type ProviderQuota,
    type ProviderQuotaWindow,
    type ProviderUsage,
    unavailableProviderQuota,
} from "@slopus/rig-providers";

import type { ConfigProviders } from "../config/types.js";

export interface ProviderQuotaService {
    get(providerId: string, options?: { fresh?: boolean }): Promise<ProviderQuota | undefined>;
}

export interface CreateProviderQuotaServiceOptions {
    env?: NodeJS.ProcessEnv;
    loadClaudeUsage?: (
        providerId: string,
        options?: { fresh?: boolean },
    ) => Promise<ProviderUsage | null>;
    loadCodexQuota?: () => Promise<ProviderQuota>;
    now?: () => number;
    providers?: ConfigProviders;
}

export function createProviderQuotaService(
    options: CreateProviderQuotaServiceOptions,
): ProviderQuotaService {
    const env = options.env ?? process.env;
    const now = options.now ?? Date.now;
    const codex = createProviderQuotaCache(
        options.loadCodexQuota ??
            (() =>
                fetchCodexProviderQuota({
                    ...(env.RIG_CODEX_BASE_URL === undefined
                        ? {}
                        : { baseUrl: env.RIG_CODEX_BASE_URL }),
                    now,
                    env,
                })),
        { now },
    );

    return {
        async get(providerId, getOptions) {
            if (providerId === "codex") return codex.get(getOptions);
            const configuredProvider = options.providers?.[providerId];
            if (providerId !== "claude" && configuredProvider?.type !== "claude") {
                return undefined;
            }
            if (options.loadClaudeUsage === undefined) return undefined;
            try {
                return providerUsageToClaudeQuota(
                    await options.loadClaudeUsage(providerId, getOptions),
                    now(),
                );
            } catch {
                return unavailableProviderQuota("claude", now());
            }
        },
    };
}

function providerUsageToClaudeQuota(
    usage: ProviderUsage | null,
    capturedAt: number,
): ProviderQuota {
    if (usage === null) return unavailableProviderQuota("claude", capturedAt);
    return {
        capturedAt: usage.capturedAt,
        source: "claude",
        windows: {
            fiveHour: providerUsageWindowToQuota(usage.windows.fiveHour, usage.capturedAt),
            weekly: providerUsageWindowToQuota(usage.windows.weekly, usage.capturedAt),
        },
    };
}

function providerUsageWindowToQuota(
    window: ProviderUsage["windows"]["fiveHour"],
    capturedAt: number,
): ProviderQuotaWindow {
    if (window === null || window.resetsAt === null) {
        return { status: "unavailable" };
    }
    return {
        capturedAt,
        status: "available",
        usedPercent: window.usedPercent,
        resetsAt: window.resetsAt,
        ...(window.durationMs === null ? {} : { durationMs: window.durationMs }),
    };
}
