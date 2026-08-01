import { ProviderUsageRequestError, type ProviderUsage } from "@slopus/rig-providers";
import { describe, expect, it, vi } from "vitest";

import { gracefulShutdown } from "../../concurrency/index.js";
import { createProviderQuotaService } from "../createProviderQuotaService.js";
import { PROVIDER_USAGE_POLL_INTERVAL_MS } from "../createProviderUsageTracker.js";
import { createProviderUsageTracker } from "../createProviderUsageTracker.js";
import { createProviderUsageService } from "../createProviderUsageService.js";

describe("createProviderUsageService", () => {
    it("shares one in-flight read between account usage and session quota", async () => {
        const reading = usage("claude", 10, 1_000);
        const loadUsage = vi.fn(async () => reading);
        const service = createProviderUsageService({ loadUsage });
        const tracker = createProviderUsageTracker({
            loadUsage: (providerId) => service.get(providerId),
            providerIds: ["claude"],
            shutdown: gracefulShutdown(),
        });
        const quota = createProviderQuotaService({
            loadClaudeUsage: (providerId) => service.get(providerId),
        });

        await Promise.all([tracker.refresh("claude"), quota.get("claude", { fresh: true })]);

        expect(loadUsage).toHaveBeenCalledOnce();
        expect(tracker.get("claude")?.usage).toBe(reading);
        await expect(quota.get("claude")).resolves.toMatchObject({
            capturedAt: 1_000,
            source: "claude",
        });
        expect(loadUsage).toHaveBeenCalledOnce();
    });

    it("allows fresh session observations while ordinary reads remain cached", async () => {
        const first = usage("claude", 10, 1_000);
        const second = usage("claude", 20, 2_000);
        const loadUsage = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
        const service = createProviderUsageService({ loadUsage });

        await expect(service.get("claude")).resolves.toBe(first);
        await expect(service.get("claude")).resolves.toBe(first);
        await expect(service.get("claude", { fresh: true })).resolves.toBe(second);

        expect(loadUsage).toHaveBeenCalledTimes(2);
    });

    it("shares a reading and respects the provider retry time after throttling", async () => {
        let now = 1_000;
        const first = usage("claude", 10, now);
        const refreshed = usage("claude", 20, now + 75 * 60 * 1_000);
        const retryAt = now + 75 * 60 * 1_000;
        const loadUsage = vi
            .fn<(providerId: string) => Promise<ProviderUsage | null>>()
            .mockResolvedValueOnce(first)
            .mockRejectedValueOnce(
                new ProviderUsageRequestError(
                    "Claude usage returned HTTP 429. Retry after 3600 seconds.",
                    { retryAt, status: 429 },
                ),
            )
            .mockResolvedValueOnce(refreshed);
        const onError = vi.fn();
        const service = createProviderUsageService({
            loadUsage,
            now: () => now,
            onError,
        });

        await expect(Promise.all([service.get("claude"), service.get("claude")])).resolves.toEqual([
            first,
            first,
        ]);
        expect(loadUsage).toHaveBeenCalledOnce();

        now += PROVIDER_USAGE_POLL_INTERVAL_MS;
        await expect(service.get("claude")).resolves.toBe(first);
        expect(loadUsage).toHaveBeenCalledTimes(2);
        expect(onError).toHaveBeenCalledWith(
            "claude",
            expect.objectContaining({ retryAt, status: 429 }),
        );

        now += PROVIDER_USAGE_POLL_INTERVAL_MS;
        await expect(service.get("claude", { fresh: true })).resolves.toBe(first);
        expect(loadUsage).toHaveBeenCalledTimes(2);

        now = retryAt;
        await expect(service.get("claude")).resolves.toBe(refreshed);
        expect(loadUsage).toHaveBeenCalledTimes(3);
    });

    it("rethrows the first failure until its retry time", async () => {
        let now = 1_000;
        const error = new ProviderUsageRequestError("Claude usage returned HTTP 429.", {
            retryAt: 3_601_000,
            status: 429,
        });
        const loadUsage = vi.fn(() => Promise.reject(error));
        const service = createProviderUsageService({
            loadUsage,
            now: () => now,
        });

        await expect(service.get("claude")).rejects.toBe(error);
        now += PROVIDER_USAGE_POLL_INTERVAL_MS;
        await expect(service.get("claude")).rejects.toBe(error);
        expect(loadUsage).toHaveBeenCalledOnce();
    });
});

function usage(providerId: string, usedPercent: number, capturedAt: number): ProviderUsage {
    return {
        providerId,
        vendor: "claude",
        capturedAt,
        planName: "Max",
        exhausted: false,
        windows: {
            fiveHour: null,
            weekly: {
                durationMs: 7 * 24 * 60 * 60 * 1_000,
                resetsAt: null,
                startsAt: null,
                usedPercent,
            },
            monthly: null,
        },
        credits: null,
    };
}
