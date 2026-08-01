import { describe, expect, it } from "vitest";

import { ProviderUsageStore } from "@/ProviderUsageStore.js";
import type { ProviderUsageEntry } from "@/protocol.js";

function entry(usedPercent: number): ProviderUsageEntry {
    return {
        providerId: "codex",
        usage: {
            providerId: "codex",
            vendor: "codex",
            capturedAt: 1_000,
            planName: "Pro",
            exhausted: false,
            windows: {
                fiveHour: null,
                weekly: { usedPercent, resetsAt: null, startsAt: null, durationMs: null },
                monthly: null,
            },
            credits: null,
        },
        checkedAt: 1_000,
        error: null,
    };
}

describe("ProviderUsageStore", () => {
    it("announces the first reading", () => {
        const store = new ProviderUsageStore();

        expect(store.applyProviders([entry(42)], 1_000)).toEqual([
            { providers: [entry(42)], type: "providers_changed" },
            {
                state: { loading: false, loadedAt: 1_000, error: null },
                type: "provider_usage_state_changed",
            },
        ]);
    });

    it("stays quiet when a later read returns what it returned before", () => {
        const store = new ProviderUsageStore();
        store.applyProviders([entry(42)], 1_000);

        // The clock always moves between two reads, so the time on its own is
        // not news; a view is only woken by usage it would render differently.
        expect(store.applyProviders([entry(42)], 9_000)).toEqual([]);
        expect(store.state().loadedAt).toBe(9_000);
    });

    it("announces usage that changed", () => {
        const store = new ProviderUsageStore();
        store.applyProviders([entry(42)], 1_000);

        expect(store.applyProviders([entry(55)], 9_000)).toEqual([
            { providers: [entry(55)], type: "providers_changed" },
        ]);
    });

    it("announces a failed read and the recovery after it", () => {
        const store = new ProviderUsageStore();
        store.applyProviders([entry(42)], 1_000);

        expect(store.applyError("the daemon is unreachable")).toEqual([
            {
                state: { loading: false, loadedAt: 1_000, error: "the daemon is unreachable" },
                type: "provider_usage_state_changed",
            },
        ]);
        // The reading is kept while the daemon is unreachable, so the read that
        // clears the error is quiet about usage and loud about the error.
        expect(store.providers()).toEqual([entry(42)]);
        expect(store.applyProviders([entry(42)], 9_000)).toEqual([
            {
                state: { loading: false, loadedAt: 9_000, error: null },
                type: "provider_usage_state_changed",
            },
        ]);
    });

    it("stays quiet when a read keeps failing the same way", () => {
        const store = new ProviderUsageStore();
        store.applyProviders([entry(42)], 1_000);
        store.applyError("the daemon is unreachable");

        expect(store.applyError("the daemon is unreachable")).toEqual([]);
    });
});
