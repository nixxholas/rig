import { Type } from "@sinclair/typebox";

import { defineTool } from "../../agent/types.js";
import type { ProviderUsageEntry } from "../../protocol/index.js";
import { formatProviderUsageLine } from "./formatProviderUsageLine.js";

const usageWindow = Type.Object(
    {
        used_percent: Type.Number(),
        resets_at: Type.Union([Type.String(), Type.Null()]),
    },
    { additionalProperties: false },
);

const providerEntry = Type.Object(
    {
        provider_id: Type.String(),
        plan: Type.Union([Type.String(), Type.Null()]),
        exhausted: Type.Union([Type.Boolean(), Type.Null()]),
        five_hour: Type.Union([usageWindow, Type.Null()]),
        weekly: Type.Union([usageWindow, Type.Null()]),
        monthly: Type.Union([usageWindow, Type.Null()]),
        remaining_credit_usd: Type.Union([Type.Number(), Type.Null()]),
        checked_at: Type.Union([Type.String(), Type.Null()]),
        status: Type.String(),
    },
    { additionalProperties: false },
);

export const getProviderUsageTool = defineTool({
    name: "get_provider_usage",
    label: "get_provider_usage",
    description:
        "Report how much of each configured provider account's plan has been used, when each limit resets, and whether an account is out of budget. This returns the most recent reading Rig holds, refreshing it when the provider allows.",
    arguments: Type.Object({}, { additionalProperties: false }),
    returnType: Type.Object(
        { providers: Type.Array(providerEntry) },
        { additionalProperties: false },
    ),
    execution: "immediate",
    steerable: false,
    async execute(_args, context) {
        const entries = (await context.providerUsage?.current()) ?? [];
        return { providers: entries.map(toToolEntry) };
    },
    toLLM: (result) => [
        {
            type: "text",
            text:
                result.providers.length === 0
                    ? "No provider usage has been recorded."
                    : result.providers.map(formatProviderUsageLine).join("\n"),
        },
    ],
    toUI: (result) =>
        result.providers.length === 0
            ? "No provider usage recorded"
            : `Read usage for ${result.providers.length} provider${result.providers.length === 1 ? "" : "s"}`,
    shouldReviewInAutoMode: () => false,
    locks: [],
});

type ToolEntry = ReturnType<typeof toToolEntry>;

function toToolEntry(entry: ProviderUsageEntry) {
    const usage = entry.usage;
    return {
        provider_id: entry.providerId,
        plan: usage?.planName ?? null,
        exhausted: usage?.exhausted ?? null,
        five_hour: toToolWindow(usage?.windows.fiveHour),
        weekly: toToolWindow(usage?.windows.weekly),
        monthly: toToolWindow(usage?.windows.monthly),
        // Money reads more naturally in dollars than in the cents we store.
        remaining_credit_usd:
            usage?.credits?.remainingCents == null ? null : usage.credits.remainingCents / 100,
        checked_at: entry.checkedAt === null ? null : new Date(entry.checkedAt).toISOString(),
        status: describeStatus(entry),
    };
}

function toToolWindow(window: { usedPercent: number; resetsAt: number | null } | null | undefined) {
    if (window == null) return null;
    return {
        used_percent: window.usedPercent,
        resets_at: window.resetsAt === null ? null : new Date(window.resetsAt).toISOString(),
    };
}

/** Says plainly why an account has no numbers, so the model does not guess. */
function describeStatus(entry: ProviderUsageEntry): string {
    if (entry.usage !== null) {
        return entry.usage.exhausted ? "Out of budget" : "Available";
    }
    if (entry.checkedAt === null) return "Not checked yet";
    return entry.error ?? "Usage is unavailable";
}

export type { ToolEntry as ProviderUsageToolEntry };
