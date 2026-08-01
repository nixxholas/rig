import type { ProviderUsage, ProviderUsageCredits } from "@/core/ProviderUsage.js";
import {
    epochMsFromIso,
    providerPlanName,
    providerUsageWindow,
    usagePercent,
} from "@/core/providerUsageValues.js";
import { readClaudeCodeOAuthToken } from "@/vendors/claude/impl/auth.js";
import { parseClaudeRateLimitHeaders } from "@/vendors/claude/parseClaudeRateLimitHeaders.js";

const DEFAULT_ANTHROPIC_BASE_URL = "https://api.anthropic.com";
const OAUTH_BETA_HEADER = "oauth-2025-04-20";
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * The cheapest model that still reports the account-wide unified limits. The
 * limits are not per-model, so probing with anything larger buys nothing.
 */
const PROBE_MODEL = "claude-haiku-4-5-20251001";

export interface FetchClaudeProviderUsageOptions {
    baseUrl?: string;
    configDir?: string;
    env?: NodeJS.ProcessEnv;
    fetch?: typeof fetch;
    now?: () => number;
    oauthToken?: string;
    probeModel?: string;
    providerId?: string;
    timeoutMs?: number;
    userAgent?: string;
}

/**
 * Reads one Claude account's usage.
 *
 * The OAuth usage endpoint is richer — it carries the plan, the scoped limits,
 * and extra-usage credits — but it requires the `user:profile` scope that only
 * a full `claude auth login` grants, and it is itself rate limited. Tokens from
 * `claude setup-token` are inference-only and never satisfy it.
 *
 * So when that endpoint cannot answer, the account is measured by the unified
 * rate-limit headers instead, which ride along on any inference response.
 */
export async function fetchClaudeProviderUsage(
    options: FetchClaudeProviderUsageOptions = {},
): Promise<ProviderUsage | null> {
    try {
        const token = options.oauthToken ?? (await readClaudeToken(options));
        if (token === undefined) return null;
        return (
            (await fetchFromUsageEndpoint(token, options)) ??
            (await probeRateLimitHeaders(token, options))
        );
    } catch {
        return null;
    }
}

async function fetchFromUsageEndpoint(
    token: string,
    options: FetchClaudeProviderUsageOptions,
): Promise<ProviderUsage | null> {
    const now = options.now ?? Date.now;
    const baseUrl = (options.baseUrl ?? DEFAULT_ANTHROPIC_BASE_URL).replace(/\/+$/u, "");
    const doFetch = options.fetch ?? fetch;
    const request = (path: string): Promise<Response> =>
        doFetch(`${baseUrl}${path}`, {
            method: "GET",
            headers: claudeHeaders(token, options),
            signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
        });

    const [usage, profile] = await Promise.all([
        request("/api/oauth/usage").catch(() => null),
        // The plan name lives on the profile; losing it must not lose usage.
        request("/api/oauth/profile").catch(() => null),
    ]);
    if (usage === null || !usage.ok) return null;

    return parseClaudeProviderUsage(await usage.json(), {
        capturedAt: now(),
        providerId: options.providerId ?? "claude",
        profile: profile !== null && profile.ok ? await profile.json() : null,
    });
}

/**
 * Measures the account with the smallest possible real request. The reply is
 * discarded; only the rate-limit headers matter. One output token stays far
 * below the resolution the limits are reported at, so the probe does not
 * meaningfully consume what it is measuring.
 */
async function probeRateLimitHeaders(
    token: string,
    options: FetchClaudeProviderUsageOptions,
): Promise<ProviderUsage | null> {
    const now = options.now ?? Date.now;
    const baseUrl = (options.baseUrl ?? DEFAULT_ANTHROPIC_BASE_URL).replace(/\/+$/u, "");
    const response = await (options.fetch ?? fetch)(`${baseUrl}/v1/messages`, {
        method: "POST",
        headers: { ...claudeHeaders(token, options), "anthropic-version": "2023-06-01" },
        body: JSON.stringify({
            model: options.probeModel ?? PROBE_MODEL,
            max_tokens: 1,
            system: [
                { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." },
            ],
            messages: [{ role: "user", content: "hi" }],
        }),
        signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
    // A refusal still carries the headers, and a rejected account is exactly
    // what the caller needs to learn, so the status is not checked here.
    return parseClaudeRateLimitHeaders(response.headers, {
        capturedAt: now(),
        providerId: options.providerId ?? "claude",
    });
}

function claudeHeaders(
    token: string,
    options: FetchClaudeProviderUsageOptions,
): Record<string, string> {
    return {
        authorization: `Bearer ${token}`,
        "anthropic-beta": OAUTH_BETA_HEADER,
        "content-type": "application/json",
        "user-agent": options.userAgent ?? "claude-cli/2.0.0 (external, cli)",
    };
}

function readClaudeToken(options: FetchClaudeProviderUsageOptions): Promise<string | undefined> {
    const env: NodeJS.ProcessEnv = {
        ...(options.env ?? process.env),
        ...(options.configDir === undefined ? {} : { CLAUDE_CONFIG_DIR: options.configDir }),
    };
    return readClaudeCodeOAuthToken({ env });
}

interface ClaudeRateLimitPayload {
    resets_at?: unknown;
    utilization?: unknown;
}

interface ClaudeLimitPayload {
    group?: unknown;
    is_active?: unknown;
    percent?: unknown;
    resets_at?: unknown;
    severity?: unknown;
}

interface ClaudeUsagePayload {
    extra_usage?: {
        is_enabled?: unknown;
        monthly_limit?: unknown;
        used_credits?: unknown;
        utilization?: unknown;
    } | null;
    five_hour?: ClaudeRateLimitPayload | null;
    limits?: readonly ClaudeLimitPayload[] | null;
    seven_day?: ClaudeRateLimitPayload | null;
    subscription_type?: unknown;
}

interface ClaudeProfilePayload {
    account?: { has_claude_max?: unknown; has_claude_pro?: unknown } | null;
}

export function parseClaudeProviderUsage(
    payload: unknown,
    context: { capturedAt: number; providerId: string; profile?: unknown },
): ProviderUsage {
    const body = (payload ?? {}) as ClaudeUsagePayload;
    const credits = parseClaudeCredits(body.extra_usage);
    return {
        providerId: context.providerId,
        vendor: "claude",
        capturedAt: context.capturedAt,
        planName:
            providerPlanName(body.subscription_type) ?? claudePlanFromProfile(context.profile),
        exhausted: isClaudeExhausted(body) && credits?.available !== true,
        windows: {
            fiveHour: parseClaudeWindow(body.five_hour, 5 * 60 * 60 * 1_000),
            weekly: parseClaudeWindow(body.seven_day, 7 * 24 * 60 * 60 * 1_000),
            monthly: null,
        },
        credits,
    };
}

function claudePlanFromProfile(profile: unknown): string | null {
    const account = (profile as ClaudeProfilePayload | null)?.account;
    if (account?.has_claude_max === true) return "Max";
    if (account?.has_claude_pro === true) return "Pro";
    return null;
}

function parseClaudeWindow(
    payload: ClaudeRateLimitPayload | null | undefined,
    durationMs: number,
): ProviderUsage["windows"]["fiveHour"] {
    const resetsAt = epochMsFromIso(payload?.resets_at);
    return providerUsageWindow({
        usedPercent: payload?.utilization,
        resetsAt,
        startsAt: resetsAt === null ? null : resetsAt - durationMs,
        durationMs,
    });
}

/**
 * An account is finished when any limit it is actually subject to has run
 * out. Anthropic marks that with a `critical` severity on an active limit.
 */
function isClaudeExhausted(body: ClaudeUsagePayload): boolean {
    for (const limit of body.limits ?? []) {
        if (limit.is_active === true && limit.severity === "critical") return true;
    }
    const fiveHour = usagePercent(body.five_hour?.utilization);
    const sevenDay = usagePercent(body.seven_day?.utilization);
    return (fiveHour !== null && fiveHour >= 100) || (sevenDay !== null && sevenDay >= 100);
}

function parseClaudeCredits(
    payload: ClaudeUsagePayload["extra_usage"],
): ProviderUsageCredits | null {
    if (payload == null) return null;
    const enabled = payload.is_enabled === true;
    const utilization = usagePercent(payload.utilization);
    return {
        available: enabled && (utilization === null || utilization < 100),
        remainingCents: null,
        unlimited: false,
        usedPercent: utilization,
    };
}
