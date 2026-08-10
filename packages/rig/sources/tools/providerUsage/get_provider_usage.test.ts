import { describe, expect, it, vi } from "vitest";

import type { AgentContext } from "../../agent/context/AgentContext.js";
import type { ToolExecutionOptions } from "../../agent/types.js";
import type { ProviderUsageEntry } from "../../protocol/index.js";
import { getProviderUsageTool } from "./get_provider_usage.js";
import { createTestRootContext } from "../../testing/createTestRootContext.js";

describe("get_provider_usage", () => {
    it("reports the most recent reading each provider has given", async () => {
        const current = vi.fn(async (): Promise<readonly ProviderUsageEntry[]> => [entry()]);
        const context = { providerUsage: { current } } as unknown as AgentContext;

        const result = await getProviderUsageTool.execute({}, context, options());

        expect(current).toHaveBeenCalledOnce();
        expect(result.providers).toEqual([
            expect.objectContaining({
                provider_id: "kirill_claude",
                plan: "Max",
                five_hour: { used_percent: 42, resets_at: "1970-01-01T00:00:02.000Z" },
                status: "Available",
            }),
        ]);
        expect(getProviderUsageTool.toLLM(result)).toEqual([
            { type: "text", text: expect.stringContaining("42%") },
        ]);
    });

    it("says plainly that nothing is known rather than inventing numbers", async () => {
        const context = {} as AgentContext;

        const result = await getProviderUsageTool.execute({}, context, options());

        expect(result.providers).toEqual([]);
        expect(getProviderUsageTool.toLLM(result)).toEqual([
            { type: "text", text: "No provider usage has been recorded." },
        ]);
    });
});

function options(): ToolExecutionOptions {
    return {
        ctx: createTestRootContext().named("provider-usage-test"),
        signal: new AbortController().signal,
    };
}

function entry(): ProviderUsageEntry {
    return {
        providerId: "kirill_claude",
        checkedAt: 1_000,
        error: null,
        usage: {
            providerId: "kirill_claude",
            vendor: "claude",
            capturedAt: 1_000,
            planName: "Max",
            exhausted: false,
            windows: {
                fiveHour: {
                    durationMs: 5 * 60 * 60 * 1_000,
                    resetsAt: 2_000,
                    startsAt: null,
                    usedPercent: 42,
                },
                weekly: null,
                monthly: null,
            },
            credits: null,
        },
    };
}
