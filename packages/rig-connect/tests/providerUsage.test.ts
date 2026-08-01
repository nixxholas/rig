import { describe, expect, it, vi } from "vitest";

import { connectRig } from "@/connectRig.js";
import type { ProviderUsageDelta, ProviderUsageState } from "@/ProviderUsageElement.js";
import type { ProviderUsageEntry } from "@/protocol.js";

function entry(providerId: string, usedPercent: number): ProviderUsageEntry {
    return {
        providerId,
        usage: {
            providerId,
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

/**
 * Serves `/provider-usage` from a queue of answers, so a test can say what the
 * second read returns without racing the first.
 */
function usageDaemon(answers: readonly (readonly ProviderUsageEntry[] | Error)[]) {
    const reads: number[] = [];
    let index = 0;
    const fetch = (input: RequestInfo | URL): Promise<Response> => {
        const url = new URL(String(input));
        if (url.pathname !== "/provider-usage") {
            return Promise.resolve(new Response("{}", { status: 200 }));
        }
        reads.push(Date.now());
        const answer = answers[Math.min(index, answers.length - 1)];
        index += 1;
        if (answer instanceof Error) return Promise.reject(answer);
        return Promise.resolve(
            new Response(JSON.stringify({ providers: answer }), { status: 200 }),
        );
    };
    return { fetch, get reads() { return reads.length; } };
}

async function settle(): Promise<void> {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

describe("connectProviderUsage", () => {
    it("keeps provider usage beneath a path-prefixed endpoint", async () => {
        const requested: string[] = [];
        const rig = connectRig({
            endpoint: "https://connector.test/capability/rig-connect",
            token: "t",
            fetch: ((input: RequestInfo | URL) => {
                requested.push(String(input));
                return Promise.resolve(
                    new Response(JSON.stringify({ providers: [entry("codex", 42)] }), {
                        status: 200,
                    }),
                );
            }) as typeof globalThis.fetch,
        });
        const usage = rig.connectProviderUsage({ onChange: () => {} });

        await settle();

        expect(requested).toEqual([
            "https://connector.test/capability/rig-connect/provider-usage",
        ]);
        expect(usage.providers()).toEqual([entry("codex", 42)]);
        usage.close();
        rig.close();
    });

    it("reports loading before the first answer, then the usage", async () => {
        const daemon = usageDaemon([[entry("codex", 42)]]);
        const rig = connectRig({
            endpoint: "http://daemon.test",
            token: "t",
            fetch: daemon.fetch as typeof globalThis.fetch,
        });
        const states: ProviderUsageState[] = [];

        const usage = rig.connectProviderUsage({
            onChange: (_providers, state) => states.push(state),
        });

        // The first frame a view renders is the loading state, handed over
        // before anything has been read.
        expect(states[0]).toEqual({ loading: true, loadedAt: null, error: null });
        expect(usage.providers()).toEqual([]);

        await settle();

        expect(usage.state().loading).toBe(false);
        expect(usage.providers()).toEqual([entry("codex", 42)]);
        usage.close();
        rig.close();
    });

    it("hands a late subscriber the readings it already has", async () => {
        const daemon = usageDaemon([[entry("codex", 42)]]);
        const rig = connectRig({
            endpoint: "http://daemon.test",
            token: "t",
            fetch: daemon.fetch as typeof globalThis.fetch,
        });
        const first = rig.connectProviderUsage({ onChange: () => {} });
        await settle();

        let openingProviders: readonly ProviderUsageEntry[] = [];
        const second = rig.connectProviderUsage({
            onChange: (providers) => {
                if (openingProviders.length === 0) openingProviders = providers;
            },
        });

        // The second view opens on what is already known rather than on a
        // second loading state, and costs no extra read.
        expect(openingProviders).toEqual([entry("codex", 42)]);
        expect(daemon.reads).toBe(1);
        first.close();
        second.close();
        rig.close();
    });

    it("reads again when a view refreshes by hand", async () => {
        const daemon = usageDaemon([[entry("codex", 42)], [entry("codex", 55)]]);
        const rig = connectRig({
            endpoint: "http://daemon.test",
            token: "t",
            fetch: daemon.fetch as typeof globalThis.fetch,
        });
        const usage = rig.connectProviderUsage({ onChange: () => {} });
        await settle();

        await usage.refresh();

        expect(daemon.reads).toBe(2);
        expect(usage.providers()[0]?.usage?.windows.weekly?.usedPercent).toBe(55);
        usage.close();
        rig.close();
    });

    it("keeps the readings it has when a read fails", async () => {
        const daemon = usageDaemon([
            [entry("codex", 42)],
            new Error("the daemon is unreachable"),
        ]);
        const rig = connectRig({
            endpoint: "http://daemon.test",
            token: "t",
            fetch: daemon.fetch as typeof globalThis.fetch,
        });
        const errors: unknown[] = [];
        const usage = rig.connectProviderUsage({
            onChange: () => {},
            onError: (error) => errors.push(error),
        });
        await settle();

        await usage.refresh();

        // A failed poll does not make the last reading untrue, and every entry
        // carries its own capture time for a view to judge.
        expect(usage.providers()).toEqual([entry("codex", 42)]);
        expect(usage.state().error).toBe("the daemon is unreachable");
        expect(usage.state().loadedAt).not.toBeNull();
        expect(errors).toHaveLength(1);
        usage.close();
        rig.close();
    });

    it("stays quiet when a poll returns what it returned before", async () => {
        const daemon = usageDaemon([[entry("codex", 42)]]);
        const rig = connectRig({
            endpoint: "http://daemon.test",
            token: "t",
            fetch: daemon.fetch as typeof globalThis.fetch,
        });
        const deltas: ProviderUsageDelta[] = [];
        const usage = rig.connectProviderUsage({
            onChange: () => {},
            onDelta: (delta) => deltas.push(delta),
        });
        await settle();
        deltas.length = 0;

        await usage.refresh();

        expect(deltas).toEqual([]);
        usage.close();
        rig.close();
    });

    it("reports a provider the daemon could not read", async () => {
        const daemon = usageDaemon([
            [{ providerId: "bedrock", usage: null, checkedAt: 1_000, error: "No usage." }],
        ]);
        const rig = connectRig({
            endpoint: "http://daemon.test",
            token: "t",
            fetch: daemon.fetch as typeof globalThis.fetch,
        });
        const usage = rig.connectProviderUsage({ onChange: () => {} });
        await settle();

        // Nothing known about one provider is a fact about that provider, not
        // a failure of the subscription.
        expect(usage.state().error).toBeNull();
        expect(usage.providers()[0]?.usage).toBeNull();
        expect(usage.providers()[0]?.error).toBe("No usage.");
        usage.close();
        rig.close();
    });

    it("polls on an interval while a view is mounted", async () => {
        vi.useFakeTimers();
        try {
            const daemon = usageDaemon([[entry("codex", 42)]]);
            const rig = connectRig({
                endpoint: "http://daemon.test",
                token: "t",
                fetch: daemon.fetch as typeof globalThis.fetch,
            });
            const usage = rig.connectProviderUsage({
                onChange: () => {},
                refreshIntervalMs: 1_000,
            });
            await vi.advanceTimersByTimeAsync(0);
            expect(daemon.reads).toBe(1);

            await vi.advanceTimersByTimeAsync(3_500);

            expect(daemon.reads).toBeGreaterThan(1);
            usage.close();
            rig.close();
        } finally {
            vi.useRealTimers();
        }
    });

    it("stops polling once the last view unmounts", async () => {
        vi.useFakeTimers();
        try {
            const daemon = usageDaemon([[entry("codex", 42)]]);
            const rig = connectRig({
                endpoint: "http://daemon.test",
                token: "t",
                fetch: daemon.fetch as typeof globalThis.fetch,
            });
            const usage = rig.connectProviderUsage({
                onChange: () => {},
                refreshIntervalMs: 1_000,
            });
            await vi.advanceTimersByTimeAsync(2_500);
            usage.close();
            const afterClose = daemon.reads;

            await vi.advanceTimersByTimeAsync(5_000);

            expect(daemon.reads).toBe(afterClose);
            rig.close();
        } finally {
            vi.useRealTimers();
        }
    });

    it("keeps polling while another view is still mounted", async () => {
        vi.useFakeTimers();
        try {
            const daemon = usageDaemon([[entry("codex", 42)]]);
            const rig = connectRig({
                endpoint: "http://daemon.test",
                token: "t",
                fetch: daemon.fetch as typeof globalThis.fetch,
            });
            const first = rig.connectProviderUsage({
                onChange: () => {},
                refreshIntervalMs: 1_000,
            });
            const second = rig.connectProviderUsage({ onChange: () => {} });
            await vi.advanceTimersByTimeAsync(0);
            first.close();
            const afterFirstClose = daemon.reads;

            await vi.advanceTimersByTimeAsync(3_500);

            expect(daemon.reads).toBeGreaterThan(afterFirstClose);
            second.close();
            rig.close();
        } finally {
            vi.useRealTimers();
        }
    });

    it("tells a closed subscriber nothing further", async () => {
        const daemon = usageDaemon([[entry("codex", 42)]]);
        const rig = connectRig({
            endpoint: "http://daemon.test",
            token: "t",
            fetch: daemon.fetch as typeof globalThis.fetch,
        });
        const onChange = vi.fn();
        const usage = rig.connectProviderUsage({ onChange });
        usage.close();
        const afterClose = onChange.mock.calls.length;

        await settle();

        expect(onChange).toHaveBeenCalledTimes(afterClose);
        rig.close();
    });

    it("refuses to subscribe on a closed connection", () => {
        const daemon = usageDaemon([[]]);
        const rig = connectRig({
            endpoint: "http://daemon.test",
            token: "t",
            fetch: daemon.fetch as typeof globalThis.fetch,
        });
        rig.close();

        expect(() => rig.connectProviderUsage({ onChange: () => {} })).toThrow(
            "This Rig connection is closed.",
        );
    });
});
