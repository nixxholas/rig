import {
    fetchClaudeProviderUsage,
    fetchCodexProviderUsage,
    fetchGrokProviderUsage,
    type ProviderUsage,
} from "@slopus/rig-providers";

import type { ConfigProviders } from "../config/types.js";

export interface LoadConfiguredProviderUsageOptions {
    env?: NodeJS.ProcessEnv;
    providerId: string;
    providers: ConfigProviders;
}

/**
 * Asks one configured provider for its usage, using its vendor's own way of
 * reporting it.
 *
 * A provider is identified by its configured type rather than its id, so a
 * second Codex or Claude account under any name is read the same way as the
 * first. Returns null when the vendor cannot report usage at all, which is the
 * case for Bedrock.
 */
export function loadConfiguredProviderUsage(
    options: LoadConfiguredProviderUsageOptions,
): Promise<ProviderUsage | null> {
    const provider = options.providers[options.providerId];
    if (provider === undefined || !provider.enabled) return Promise.resolve(null);
    const env = options.env ?? process.env;

    if (provider.type === "codex") {
        return fetchCodexProviderUsage({
            ...(provider.authFile === undefined ? {} : { authPath: provider.authFile }),
            env,
            providerId: options.providerId,
        });
    }
    if (provider.type === "claude") {
        return fetchClaudeProviderUsage({
            ...(env.ANTHROPIC_BASE_URL === undefined ? {} : { baseUrl: env.ANTHROPIC_BASE_URL }),
            ...(provider.configDir === undefined ? {} : { configDir: provider.configDir }),
            ...(provider.oauthToken === undefined ? {} : { oauthToken: provider.oauthToken }),
            env,
            providerId: options.providerId,
        });
    }
    if (provider.type === "grok") {
        return fetchGrokProviderUsage({
            ...(provider.authFile === undefined ? {} : { authFile: provider.authFile }),
            env,
            providerId: options.providerId,
        });
    }
    // Bedrock bills through AWS, which reports no subscription usage of its own.
    return Promise.resolve(null);
}
