import {
    createProviderQuotaCache,
    fetchCodexProviderQuota,
    type ProviderQuota,
    type ProviderUsage,
    unavailableProviderQuota,
} from "@slopus/rig-providers";

import type { ConfigProviders } from "../config/types.js";
import { providerUsageToClaudeQuota } from "./providerUsageToClaudeQuota.js";

export interface ProviderQuotaService {
    get(providerId: string): Promise<ProviderQuota | undefined>;
}

export interface CreateProviderQuotaServiceOptions {
    env?: NodeJS.ProcessEnv;
    loadClaudeUsage?: (providerId: string) => Promise<ProviderUsage | null>;
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
        async get(providerId) {
            if (providerId === "codex") return codex.get();
            const configuredProvider = options.providers?.[providerId];
            if (providerId !== "claude" && configuredProvider?.type !== "claude") {
                return undefined;
            }
            if (options.loadClaudeUsage === undefined) return undefined;
            try {
                return providerUsageToClaudeQuota(await options.loadClaudeUsage(providerId), now());
            } catch {
                return unavailableProviderQuota("claude", now());
            }
        },
    };
}
